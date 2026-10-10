// Integration tests for the security review fixes: SSE caps/backpressure, code guessing, slowloris, HSTS.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { api, openSse, startTestServer } from './helpers.ts';
import type { SseClient, TestServer } from './helpers.ts';

let srv: TestServer;
let base: string;
const sseClients: SseClient[] = [];

before(async () => {
  srv = await startTestServer({ config: { trustedProxyHops: 1 }, sse: { maxPerIp: 3 }, requestTimeoutMs: 300 });
  base = `http://127.0.0.1:${srv.port}`;
});
after(async () => {
  for (const c of sseClients) c.close();
  await srv.close();
});

async function assertAlive() {
  assert.equal((await api(base, 'GET', '/healthz')).status, 200);
}

let ipCounter = 0;
function nextIp() {
  ipCounter += 1;
  return `10.20.${Math.floor(ipCounter / 250)}.${ipCounter % 250}`;
}

async function createRoom() {
  const res = await fetch(`${base}/api/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': nextIp() },
    body: JSON.stringify({ hostName: 'Host' }),
  });
  assert.equal(res.status, 201);
  return res.json() as Promise<{ code: string; hostToken: string }>;
}

function get(path: string, ip: string, headers: Record<string, string> = {}) {
  return fetch(base + path, { headers: { 'X-Forwarded-For': ip, ...headers } });
}

/** SSE stream opened with a chosen client IP. Resolves with the status code and the request handle. */
function openSseFrom(path: string, ip: string): Promise<{ status: number; req: http.ClientRequest; body: Promise<string> }> {
  return new Promise((resolve, reject) => {
    const req = http.get(base + path, { headers: { 'X-Forwarded-For': ip } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { text += c; });
      const body = new Promise<string>((r) => { res.on('end', () => r(text)); res.on('close', () => r(text)); });
      resolve({ status: res.statusCode ?? 0, req, body });
    });
    req.on('error', reject);
  });
}

describe('SSE caps (H1)', () => {
  test('per-IP cap answers 503 capacity and frees the slot on disconnect', async () => {
    const room = await createRoom();
    const ip = nextIp();
    const open = [];
    for (let i = 0; i < 3; i += 1) {
      const s = await openSseFrom(`/api/rooms/${room.code}/events`, ip);
      assert.equal(s.status, 200);
      open.push(s);
    }
    const over = await openSseFrom(`/api/rooms/${room.code}/events`, ip);
    assert.equal(over.status, 503);
    assert.equal(JSON.parse(await over.body).error, 'capacity');
    assert.equal((await openSseFrom(`/api/rooms/${room.code}/events`, nextIp())).status, 200, 'other IPs unaffected');

    open[0].req.destroy();
    for (let i = 0; i < 50 && srv.hub.connectionsFrom(ip) > 2; i += 1) await new Promise((r) => setTimeout(r, 10));
    const again = await openSseFrom(`/api/rooms/${room.code}/events`, ip);
    assert.equal(again.status, 200);
    for (const s of [...open, again]) s.req.destroy();
  });

  test('a real client that stops reading is destroyed once its buffer passes 64 KB', async () => {
    const room = await createRoom();
    const socket = net.connect(srv.port, '127.0.0.1');
    await new Promise<void>((r) => socket.once('connect', () => r()));
    socket.write(`GET /api/rooms/${room.code}/events HTTP/1.1\r\nHost: localhost\r\nX-Forwarded-For: ${nextIp()}\r\n\r\n`);
    socket.pause(); // never read: the kernel buffers fill, then Node's userland buffer grows
    for (let i = 0; i < 50 && srv.hub.connectionCount(room.code) === 0; i += 1) await new Promise((r) => setTimeout(r, 10));
    assert.equal(srv.hub.connectionCount(room.code), 1);

    const snapshot = { ...(await api(base, 'GET', `/api/rooms/${room.code}`)).body, padding: 'x'.repeat(1 << 20) };
    for (let i = 0; i < 40 && srv.hub.connectionCount(room.code) > 0; i += 1) {
      srv.hub.broadcast(room.code, snapshot);
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.equal(srv.hub.connectionCount(room.code), 0, 'stalled client should have been dropped');
    socket.destroy();
    await assertAlive();
  });
});

describe('room code guessing (L4)', () => {
  test('the 21st unknown code from one client is 429, then every room lookup is', async () => {
    const room = await createRoom();
    const ip = nextIp();
    for (let i = 0; i < 20; i += 1) {
      const res = await get(`/api/rooms/ZZZZ${String(i).padStart(2, '0')}`, ip);
      assert.equal(res.status, 404, `miss ${i + 1}`);
      await res.arrayBuffer();
    }
    const blocked = await get('/api/rooms/ZZZZZZ', ip);
    assert.equal(blocked.status, 429);
    assert.equal((await blocked.json()).error, 'rate_limited');
    // A valid code must not answer 200 now, or the 429s would still leak which codes exist.
    assert.equal((await get(`/api/rooms/${room.code}`, ip)).status, 429);
    assert.equal((await get(`/api/rooms/${room.code}`, nextIp())).status, 200, 'other clients unaffected');
    assert.equal((await get('/healthz', ip)).status, 200);
  });

  test('malformed codes and SSE misses count too', async () => {
    const ip = nextIp();
    for (let i = 0; i < 10; i += 1) await (await get('/api/rooms/bad', ip)).arrayBuffer();
    for (let i = 0; i < 10; i += 1) await (await get('/api/rooms/ZZZZZZ/events', ip)).arrayBuffer();
    assert.equal((await get('/api/rooms/ZZZZZZ', ip)).status, 429);
  });
});

describe('slowloris (M3)', () => {
  test('SSE stays open longer than requestTimeout', async () => {
    const room = await createRoom();
    const sse = await openSse(`${base}/api/rooms/${room.code}/events`);
    sseClients.push(sse);
    await sse.waitFor((e) => e.event === 'state');
    await new Promise((r) => setTimeout(r, 1200)); // 4x the 300 ms requestTimeout
    const joined = await api(base, 'POST', `/api/rooms/${room.code}/join`, { name: 'Ana' });
    assert.equal(joined.status, 201);
    const event = await sse.waitFor((e) => e.event === 'state' && JSON.parse(e.data).players.length === 2);
    assert.ok(event);
  });

  test('a POST whose body trickles in is cut after requestTimeout', async () => {
    const started = Date.now();
    const socket = net.connect(srv.port, '127.0.0.1');
    let response = '';
    socket.setEncoding('latin1');
    socket.on('data', (c: string) => { response += c; });
    socket.on('error', () => {});
    const closed = new Promise<void>((r) => socket.on('close', () => r()));
    socket.write('POST /api/rooms HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 64\r\n\r\n{"host');
    const trickle = setInterval(() => socket.write(' '), 100);
    await closed;
    clearInterval(trickle);
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 250 && elapsed < 3000, `closed after ${elapsed} ms`);
    assert.ok(response === '' || response.startsWith('HTTP/1.1 408'), response.slice(0, 40));
    await assertAlive();
  });

  test('server limits are set', () => {
    assert.equal(srv.server.requestTimeout, 300);
    assert.equal(srv.server.headersTimeout, 300);
    assert.equal(srv.server.maxConnections, 3000);
  });
});

describe('HSTS', () => {
  test('sent only when the trusted proxy says the request came over HTTPS', async () => {
    const https = await get('/', nextIp(), { 'X-Forwarded-Proto': 'https' });
    assert.equal(https.headers.get('strict-transport-security'), 'max-age=15552000; includeSubDomains');
    const plain = await get('/', nextIp(), { 'X-Forwarded-Proto': 'http' });
    assert.equal(plain.headers.get('strict-transport-security'), null);
    assert.equal((await get('/', nextIp())).headers.get('strict-transport-security'), null);
  });

  test('ignored without trusted proxy hops (local http dev)', async () => {
    const local = await startTestServer({ config: { trustedProxyHops: 0 } });
    try {
      const res = await fetch(`http://127.0.0.1:${local.port}/`, { headers: { 'X-Forwarded-Proto': 'https' } });
      assert.equal(res.headers.get('strict-transport-security'), null);
    } finally {
      await local.close();
    }
  });
});
