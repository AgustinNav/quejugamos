// Room privacy and lifecycle: member-only snapshots, single-use SSE tickets, host close, empty-room cleanup.
import { after, afterEach, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { api, eventsPath, openRoomSse, openSse, rawPost, rawRequest, startTestServer } from './helpers.ts';
import type { SseClient, TestServer } from './helpers.ts';

let srv: TestServer;
let base: string;
const sseClients: SseClient[] = [];
const secrets: string[] = [];

before(async () => {
  srv = await startTestServer({ config: { trustedProxyHops: 1 } });
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
async function createRoom(hostName = 'Agus') {
  ipCounter += 1;
  const res = await fetch(`${base}/api/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.7.0.${ipCounter}` },
    body: JSON.stringify({ hostName }),
  });
  assert.equal(res.status, 201);
  const room = await res.json() as { code: string; hostToken: string; playerToken: string; playerId: string };
  secrets.push(room.hostToken);
  return room;
}

async function join(code: string, name: string) {
  const res = await api(base, 'POST', `/api/rooms/${code}/join`, { name });
  assert.equal(res.status, 201);
  secrets.push(res.body.playerToken);
  return res.body as { playerToken: string; playerId: string };
}

async function ticketFor(code: string, token: string): Promise<string> {
  const res = await api(base, 'POST', `/api/rooms/${code}/stream-ticket`, {}, token);
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body), ['ticket']);
  secrets.push(res.body.ticket);
  return res.body.ticket;
}

const events = (code: string, query = '') => `/api/rooms/${code}/events${query}`;

/** GET that must be refused. A stream opened by mistake is cancelled, so the assertion fails instead of hanging. */
async function refused(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(base + path, { signal: AbortSignal.timeout(2000) });
  if (res.headers.get('content-type')?.startsWith('text/event-stream')) {
    await res.body?.cancel();
    return { status: res.status, body: null };
  }
  return { status: res.status, body: await res.json() };
}

async function waitUntil(predicate: () => boolean, what: string) {
  for (let i = 0; i < 100 && !predicate(); i += 1) await new Promise((r) => setTimeout(r, 10));
  assert.ok(predicate(), what);
}

describe('GET /api/rooms/:code: names only for members', () => {
  test('without a member token: only code, phase and counts', async () => {
    const room = await createRoom('Agus');
    const ana = await join(room.code, 'Ana');
    const other = await createRoom('Zoe');
    await api(base, 'POST', `/api/rooms/${room.code}/start`, { filters: { platforms: ['PC'], maxPrice: null, playerCount: null } }, room.hostToken);
    const snap = await api(base, 'GET', `/api/rooms/${room.code}`, undefined, room.hostToken);
    await api(base, 'POST', `/api/rooms/${room.code}/vote`, { gameId: snap.body.deck[0], vote: 'like' }, room.hostToken);
    await api(base, 'POST', `/api/rooms/${room.code}/vote`, { gameId: snap.body.deck[0], vote: 'nope' }, ana.playerToken);

    const expected = { code: room.code, phase: 'voting', playerCount: 2, maxPlayers: 12 };
    for (const token of [undefined, other.hostToken, 'not-a-real-token']) {
      const res = await api(base, 'GET', `/api/rooms/${room.code.toLowerCase()}`, undefined, token);
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, expected, `token: ${token}`);
      const text = JSON.stringify(res.body);
      for (const leak of ['Agus', 'Ana', ana.playerId, 'like', 'nope', snap.body.deck[0]]) assert.ok(!text.includes(leak), leak);
    }

    for (const token of [room.hostToken, ana.playerToken]) {
      const member = await api(base, 'GET', `/api/rooms/${room.code}`, undefined, token);
      assert.deepEqual(member.body.players.map((p: { name: string }) => p.name), ['Agus', 'Ana']);
      assert.ok(member.body.results[snap.body.deck[0]]);
    }
  });

  test('a kicked player falls back to the public view', async () => {
    const room = await createRoom();
    const ana = await join(room.code, 'Ana');
    await api(base, 'POST', `/api/rooms/${room.code}/kick`, { playerId: ana.playerId }, room.hostToken);
    const res = await api(base, 'GET', `/api/rooms/${room.code}`, undefined, ana.playerToken);
    assert.deepEqual(res.body, { code: room.code, phase: 'lobby', playerCount: 1, maxPlayers: 12 });
  });
});

describe('SSE stream tickets', () => {
  afterEach(assertAlive);

  test('issue -> connect OK -> reuse is 401 and opens no stream', async () => {
    const room = await createRoom();
    const ana = await join(room.code, 'Ana');
    const ticket = await ticketFor(room.code, ana.playerToken);
    const sse = await openSse(base + events(room.code, `?ticket=${ticket}`));
    sseClients.push(sse);
    assert.equal(sse.status, 200);
    const first = JSON.parse((await sse.waitFor((e) => e.event === 'state')).data);
    assert.equal(first.players.length, 2);
    assert.equal(srv.hub.connectionCount(room.code), 1);

    const reused = await refused(events(room.code, `?ticket=${ticket}`));
    assert.equal(reused.status, 401);
    assert.equal(reused.body.error, 'unauthorized');
    assert.equal(srv.hub.connectionCount(room.code), 1, 'a rejected ticket must not open a stream');
  });

  test('expired, other room, missing and malformed tickets are 401', async () => {
    const room = await createRoom();
    const other = await createRoom();
    const expired = await ticketFor(room.code, room.hostToken);
    srv.clock.t += 30_000;
    try {
      assert.equal((await refused(events(room.code, `?ticket=${expired}`))).status, 401, 'expired');
    } finally {
      srv.clock.t -= 30_000;
    }
    const foreign = await ticketFor(other.code, other.hostToken);
    assert.equal((await refused(events(room.code, `?ticket=${foreign}`))).status, 401, 'other room');
    assert.equal((await refused(events(other.code, `?ticket=${foreign}`))).status, 401, 'burnt by the failed try');

    const valid = await ticketFor(room.code, room.hostToken);
    const malformed = ['', '?ticket=', '?ticket=short', `?ticket=${'x'.repeat(200)}`, `?ticket=${valid}&ticket=${valid}`,
      '?ticket=%E0%A4%A', '?ticket=%00', `?Ticket=${valid}`, `?ticket=${room.hostToken}`];
    for (const query of malformed) {
      const res = await refused(events(room.code, query));
      assert.equal(res.status, 401, query);
      assert.equal(res.body.error, 'unauthorized');
    }
    assert.equal(await rawRequest(srv.port, `GET /api/rooms/${room.code}/events?ticket=%E0%A4%A%%% HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`), 401);
    assert.equal(srv.hub.connectionCount(room.code), 0);
  });

  test('a kicked player cannot use a ticket issued before the kick; unknown room is 404', async () => {
    const room = await createRoom();
    const ana = await join(room.code, 'Ana');
    const ticket = await ticketFor(room.code, ana.playerToken);
    await api(base, 'POST', `/api/rooms/${room.code}/kick`, { playerId: ana.playerId }, room.hostToken);
    assert.equal((await refused(events(room.code, `?ticket=${ticket}`))).status, 401);
    assert.equal((await api(base, 'POST', `/api/rooms/${room.code}/stream-ticket`, {}, ana.playerToken)).status, 401);
    const unknown = await fetch(`${base}/api/rooms/ZZZZZZ/events?ticket=${ticket}`, { headers: { 'X-Forwarded-For': '10.6.6.6' } });
    assert.equal(unknown.status, 404);
    await unknown.arrayBuffer();
  });

  test('stream-ticket: auth and malformed input', async () => {
    const room = await createRoom();
    const other = await createRoom();
    const path = `/api/rooms/${room.code}/stream-ticket`;
    assert.equal((await api(base, 'POST', path, {})).status, 401);
    assert.equal((await api(base, 'POST', path, {}, other.hostToken)).status, 401);
    assert.equal((await rawPost(base, path, '{oops', 'application/json', room.hostToken)).status, 400);
    assert.equal((await rawPost(base, path, '{}', 'text/plain', room.hostToken)).status, 415);
    assert.equal((await rawPost(base, path, `{"x":"${'y'.repeat(2048)}"}`, 'application/json', room.hostToken)).status, 413);
    assert.equal((await api(base, 'GET', path, undefined, room.hostToken)).status, 405);
    const ok = await api(base, 'POST', path, undefined, room.hostToken);
    assert.equal(ok.status, 415, 'body-less POST without a JSON content type');
  });

  test('per-client SSE caps still apply to ticketed streams', async () => {
    const capped = await startTestServer({ sse: { maxPerRoom: 1 } });
    const cbase = `http://127.0.0.1:${capped.port}`;
    try {
      const room = (await api(cbase, 'POST', '/api/rooms', { hostName: 'H' })).body;
      const first = await openRoomSse(cbase, room.code, room.hostToken);
      assert.equal(first.status, 200);
      const second = await api(cbase, 'GET', await eventsPath(cbase, room.code, room.hostToken));
      assert.equal(second.status, 503);
      assert.equal(second.body.error, 'capacity');
      first.close();
    } finally {
      await capped.close();
    }
  });
});

describe('POST /api/rooms/:code/close', () => {
  afterEach(assertAlive);

  test('auth matrix: no token 401, foreign 401, player 403 not_host', async () => {
    const room = await createRoom();
    const ana = await join(room.code, 'Ana');
    const other = await createRoom();
    const path = `/api/rooms/${room.code}/close`;
    assert.equal((await api(base, 'POST', path, {})).status, 401);
    assert.equal((await api(base, 'POST', path, {}, other.hostToken)).status, 401);
    const player = await api(base, 'POST', path, {}, ana.playerToken);
    assert.equal(player.status, 403);
    assert.equal(player.body.error, 'not_host');
    assert.equal((await api(base, 'GET', `/api/rooms/${room.code}`)).status, 200, 'room survives');
  });

  test('malformed input: broken JSON, wrong content type, oversized, wrong method, unknown room', async () => {
    const room = await createRoom();
    const path = `/api/rooms/${room.code}/close`;
    assert.equal((await rawPost(base, path, '{', 'application/json', room.hostToken)).status, 400);
    assert.equal((await rawPost(base, path, '{}', 'text/plain', room.hostToken)).status, 415);
    assert.equal((await rawPost(base, path, `{"x":"${'y'.repeat(2048)}"}`, 'application/json', room.hostToken)).status, 413);
    assert.equal((await api(base, 'GET', path, undefined, room.hostToken)).status, 405);
    const unknown = await fetch(`${base}/api/rooms/ZZZZZZ/close`, {
      method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${room.hostToken}`, 'X-Forwarded-For': '10.6.6.7' },
    });
    assert.equal(unknown.status, 404);
    await unknown.arrayBuffer();
    assert.equal((await api(base, 'GET', `/api/rooms/${room.code}`)).status, 200, 'room survives');
  });

  test('host closes: every stream gets `closed`, then the room is gone (404)', async () => {
    const room = await createRoom();
    const ana = await join(room.code, 'Ana');
    const hostSse = await openRoomSse(base, room.code, room.hostToken);
    const anaSse = await openRoomSse(base, room.code, ana.playerToken);
    sseClients.push(hostSse, anaSse);
    await anaSse.waitFor((e) => e.event === 'state');
    const spare = await ticketFor(room.code, ana.playerToken);

    const closed = await api(base, 'POST', `/api/rooms/${room.code}/close`, {}, room.hostToken);
    assert.equal(closed.status, 200);
    assert.deepEqual(closed.body, { closed: true });
    for (const sse of [hostSse, anaSse]) {
      await sse.waitFor((e) => e.event === 'closed');
      await sse.ended;
    }
    assert.equal(srv.hub.connectionCount(room.code), 0);
    for (const [method, path, body, token] of [
      ['GET', `/api/rooms/${room.code}`, undefined, room.hostToken],
      ['POST', `/api/rooms/${room.code}/join`, { name: 'Late' }, undefined],
      ['POST', `/api/rooms/${room.code}/stream-ticket`, {}, ana.playerToken],
      ['GET', events(room.code, `?ticket=${spare}`), undefined, undefined],
      ['POST', `/api/rooms/${room.code}/close`, {}, room.hostToken],
    ] as const) {
      const res = await api(base, method, path, body, token);
      assert.equal(res.status, 404, `${method} ${path}`);
    }
    const log = srv.logs.map((l) => JSON.parse(l)).find((l) => l.event === 'room_expired' && l.roomCode === room.code);
    assert.equal(log?.reason, 'closed_by_host');
  });
});

describe('presence-based cleanup on the real server', () => {
  test('room deleted 10 min after its last stream left; reconnecting in time keeps it', async () => {
    const room = await createRoom();
    const kept = await createRoom();
    for (const r of [room, kept]) {
      const sse = await openRoomSse(base, r.code, r.hostToken);
      await sse.waitFor((e) => e.event === 'state');
      sse.close();
      await waitUntil(() => srv.hub.connectionCount(r.code) === 0, 'disconnect not noticed');
    }
    srv.clock.t += 5 * 60 * 1000;
    const back = await openRoomSse(base, kept.code, kept.hostToken);
    sseClients.push(back);
    await back.waitFor((e) => e.event === 'state');
    srv.clock.t += 5 * 60 * 1000 + 1;
    try {
      const expired = srv.store.expire();
      assert.ok(expired.includes(room.code));
      assert.ok(!expired.includes(kept.code));
    } finally {
      srv.clock.t -= 10 * 60 * 1000 + 1;
    }
    assert.equal((await api(base, 'GET', `/api/rooms/${room.code}`)).status, 404);
    assert.equal((await api(base, 'GET', `/api/rooms/${kept.code}`)).status, 200);
    const log = srv.logs.map((l) => JSON.parse(l)).find((l) => l.event === 'room_expired' && l.roomCode === room.code);
    assert.equal(log?.reason, 'empty');
  });
});

describe('logs', () => {
  test('no token or ticket ever reaches the logs', () => {
    assert.ok(secrets.length > 10, 'the suite should have produced secrets to look for');
    const logs = srv.logs.join('\n');
    for (const secret of secrets) assert.ok(!logs.includes(secret), 'secret leaked into logs');
  });
});
