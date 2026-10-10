import { after, afterEach, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { api, openSse, rawPost, rawRequest, startTestServer } from './helpers.ts';
import type { SseClient, TestServer } from './helpers.ts';

const FILTERS = { platforms: ['PC', 'PlayStation', 'Xbox', 'Switch', 'Mobile'], maxPrice: null, fitsGroup: false };

let srv: TestServer;
let base: string;
const sseClients: SseClient[] = [];

before(async () => {
  srv = await startTestServer({ config: { trustedProxyHops: 1 } });
  base = `http://127.0.0.1:${srv.port}`;
});
after(async () => {
  for (const c of sseClients) c.close();
  await srv.close();
});

/** Raw HEAD request: resolves with the status and whether the server ended the response within 1 s. */
function headRequest(port: number, path: string): Promise<{ status: number; ended: boolean }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'HEAD' }, (res) => {
      const timer = setTimeout(() => { req.destroy(); resolve({ status: res.statusCode ?? 0, ended: false }); }, 1000);
      res.on('end', () => { clearTimeout(timer); resolve({ status: res.statusCode ?? 0, ended: true }); });
      res.resume();
    });
    req.on('error', reject);
    req.end();
  });
}

async function assertAlive() {
  const res = await api(base, 'GET', '/healthz');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true });
}

let ipCounter = 0;
/** Each room gets its own fake IP so the per-IP creation limit doesn't interfere. */
async function createRoom(hostName = 'Host') {
  ipCounter += 1;
  const res = await fetch(`${base}/api/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.9.0.${ipCounter}` },
    body: JSON.stringify({ hostName }),
  });
  assert.equal(res.status, 201);
  return res.json() as Promise<{ code: string; hostToken: string; playerToken: string; playerId: string }>;
}

describe('full flow', () => {
  test('create -> join -> start -> vote xN -> SSE gets the updated snapshot', async () => {
    const room = await createRoom('Agus');
    assert.match(room.code, /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/);

    const ana = await api(base, 'POST', `/api/rooms/${room.code.toLowerCase()}/join`, { name: 'Ana' });
    assert.equal(ana.status, 201);
    assert.deepEqual(Object.keys(ana.body).sort(), ['playerId', 'playerToken']);

    const sse = await openSse(`${base}/api/rooms/${room.code}/events`);
    sseClients.push(sse);
    assert.equal(sse.status, 200);
    assert.match(String(sse.headers['content-type']), /^text\/event-stream/);
    const initial = JSON.parse((await sse.waitFor((e) => e.event === 'state')).data);
    assert.equal(initial.players.length, 2);
    assert.equal(initial.phase, 'lobby');

    const started = await api(base, 'POST', `/api/rooms/${room.code}/start`, { filters: FILTERS }, room.hostToken);
    assert.equal(started.status, 200);
    assert.equal(started.body.phase, 'voting');
    assert.ok(started.body.deck.length > 0);
    const first = started.body.deck[0];

    const v1 = await api(base, 'POST', `/api/rooms/${room.code}/vote`, { gameId: first, vote: 'like' }, room.playerToken);
    assert.equal(v1.status, 200);
    assert.equal(v1.body.index, 0);
    const v2 = await api(base, 'POST', `/api/rooms/${room.code}/vote`, { gameId: first, vote: 'like' }, ana.body.playerToken);
    assert.equal(v2.body.index, 1);
    assert.deepEqual(v2.body.lastResult, { gameId: first, likes: 2, nopes: 0, match: true });

    const event = await sse.waitFor((e) => e.event === 'state' && JSON.parse(e.data).version === v2.body.version);
    const pushed = JSON.parse(event.data);
    assert.deepEqual(pushed, v2.body);
    assert.ok(!event.data.includes(room.hostToken) && !event.data.includes(ana.body.playerToken));

    const snap = await api(base, 'GET', `/api/rooms/${room.code}`);
    assert.deepEqual(snap.body, v2.body);

    const next = await api(base, 'POST', `/api/rooms/${room.code}/next`, {}, room.hostToken);
    assert.equal(next.body.index, 2);
    const undo = await api(base, 'POST', `/api/rooms/${room.code}/undo`, {}, room.hostToken);
    assert.equal(undo.body.index, 1);

    const logs = srv.logs.join('\n');
    assert.ok(!logs.includes(room.hostToken) && !logs.includes(ana.body.playerToken), 'tokens leaked into logs');
    for (const event of ['room_created', 'player_joined', 'game_started', 'card_closed']) {
      assert.ok(srv.logs.some((l) => JSON.parse(l).event === event), `missing log ${event}`);
    }
    assert.ok(srv.logs.some((l) => JSON.parse(l).event === 'card_closed' && JSON.parse(l).match === true));
  });

  test('start uses Steam prices for maxPrice (stub price 9.99)', async () => {
    const room = await createRoom();
    const res = await api(base, 'POST', `/api/rooms/${room.code}/start`, { filters: { ...FILTERS, maxPrice: 5 } }, room.hostToken);
    assert.equal(res.status, 200);
    // Every Steam game costs 9.99 in the stub, so only non-Steam games (unknown/free price) remain.
    for (const id of res.body.deck) assert.ok(['minecraft', 'fortnite', 'valorant'].includes(id), id);
  });

  test('start answers 422 empty_deck and 400 invalid_filters', async () => {
    const room = await createRoom();
    const empty = await api(base, 'POST', `/api/rooms/${room.code}/start`, { filters: { ...FILTERS, platforms: [] } }, room.hostToken);
    assert.equal(empty.status, 422);
    assert.equal(empty.body.error, 'empty_deck');
    const bad = await api(base, 'POST', `/api/rooms/${room.code}/start`, { filters: { platforms: 'PC' } }, room.hostToken);
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, 'invalid_filters');
  });

  test('kick: host removes a ghost player, the card closes and SSE gets the new snapshot', async () => {
    const room = await createRoom();
    const ana = (await api(base, 'POST', `/api/rooms/${room.code}/join`, { name: 'Ana' })).body;
    const ghost = (await api(base, 'POST', `/api/rooms/${room.code}/join`, { name: 'Ana2' })).body;
    const started = await api(base, 'POST', `/api/rooms/${room.code}/start`, { filters: FILTERS }, room.hostToken);
    const first = started.body.deck[0];
    await api(base, 'POST', `/api/rooms/${room.code}/vote`, { gameId: first, vote: 'like' }, room.playerToken);
    await api(base, 'POST', `/api/rooms/${room.code}/vote`, { gameId: first, vote: 'like' }, ana.playerToken);

    const sse = await openSse(`${base}/api/rooms/${room.code}/events`);
    sseClients.push(sse);
    await sse.waitFor((e) => e.event === 'state');

    const kicked = await api(base, 'POST', `/api/rooms/${room.code}/kick`, { playerId: ghost.playerId }, room.hostToken);
    assert.equal(kicked.status, 200);
    assert.ok(!kicked.body.players.some((p: { id: string }) => p.id === ghost.playerId));
    assert.equal(kicked.body.index, 1);
    assert.deepEqual(kicked.body.lastResult, { gameId: first, likes: 2, nopes: 0, match: true });

    const event = await sse.waitFor((e) => e.event === 'state' && JSON.parse(e.data).version === kicked.body.version);
    assert.deepEqual(JSON.parse(event.data), kicked.body);

    const stale = await api(base, 'POST', `/api/rooms/${room.code}/vote`, { gameId: started.body.deck[1], vote: 'like' }, ghost.playerToken);
    assert.equal(stale.status, 401);
    assert.equal(stale.body.error, 'unauthorized');

    const kickLog = srv.logs.map((l) => JSON.parse(l)).find((l) => l.event === 'player_kicked' && l.roomCode === room.code);
    assert.ok(kickLog, 'missing player_kicked log');
    assert.equal(kickLog.playerId, ghost.playerId);
    assert.ok(!JSON.stringify(kickLog).includes('Ana2'), 'names must not be logged');
  });

  test('kick errors: unknown player, host, non-host, malformed id', async () => {
    const room = await createRoom();
    const ana = (await api(base, 'POST', `/api/rooms/${room.code}/join`, { name: 'Ana' })).body;
    const path = `/api/rooms/${room.code}/kick`;
    const cases: Array<[unknown, string | undefined, number, string]> = [
      [{ playerId: 'p_nobody' }, room.hostToken, 404, 'player_not_found'],
      [{ playerId: room.playerId }, room.hostToken, 409, 'cannot_kick_host'],
      [{ playerId: room.playerId }, ana.playerToken, 403, 'not_host'],
      [{ playerId: 42 }, room.hostToken, 400, 'invalid_player'],
      [{}, room.hostToken, 400, 'invalid_player'],
      [[ana.playerId], room.hostToken, 400, 'invalid_player'],
    ];
    for (const [body, token, status, error] of cases) {
      const res = await api(base, 'POST', path, body, token);
      assert.equal(res.status, status, JSON.stringify(body));
      assert.equal(res.body.error, error);
    }
    await assertAlive();
  });

  test('HEAD on events answers the headers and ends without holding a stream', async () => {
    const room = await createRoom();
    const { status, ended } = await headRequest(srv.port, `/api/rooms/${room.code}/events`);
    assert.equal(status, 200);
    assert.ok(ended, 'HEAD response did not end');
    assert.equal(srv.hub.connectionCount(room.code), 0);
    assert.equal((await headRequest(srv.port, '/api/rooms/ZZZZZZ/events')).status, 404);
  });

  test('SSE receives closed when the room expires', async () => {
    const room = await createRoom();
    const sse = await openSse(`${base}/api/rooms/${room.code}/events`);
    sseClients.push(sse);
    await sse.waitFor((e) => e.event === 'state');
    srv.clock.t += 3 * 60 * 60 * 1000;
    srv.store.expire();
    await sse.waitFor((e) => e.event === 'closed');
    await sse.ended;
    srv.clock.t = Date.now();
    assert.ok(srv.logs.some((l) => JSON.parse(l).event === 'room_expired' && JSON.parse(l).roomCode === room.code));
    assert.equal((await api(base, 'GET', `/api/rooms/${room.code}`)).status, 404);
  });
});

describe('malformed input never kills the process', () => {
  afterEach(assertAlive);

  const POSTS = ['join', 'start', 'vote', 'next', 'undo', 'kick'];

  test('POST /api/rooms: broken JSON, wrong content-type, 2 KB body, bad name', async () => {
    const broken = await rawPost(base, '/api/rooms', '{"hostName": ');
    assert.equal(broken.status, 400);
    assert.equal(broken.body.error, 'invalid_json');
    assert.ok(typeof broken.body.message === 'string');
    assert.equal((await rawPost(base, '/api/rooms', '{"hostName":"x"}', 'text/plain')).status, 415);
    assert.equal((await rawPost(base, '/api/rooms', JSON.stringify({ hostName: 'x'.repeat(2048) }))).status, 413);
    const badName = await api(base, 'POST', '/api/rooms', { hostName: '' });
    assert.equal(badName.status, 400);
    assert.equal(badName.body.error, 'invalid_name');
    assert.equal((await api(base, 'POST', '/api/rooms', [1, 2])).body.error, 'invalid_name');
    assert.equal((await api(base, 'POST', '/api/rooms', null)).body.error, 'invalid_name');
  });

  for (const action of POSTS) {
    test(`POST /api/rooms/:code/${action}: every malformed variant`, async () => {
      const room = await createRoom();
      const other = await createRoom();
      const path = `/api/rooms/${room.code}/${action}`;
      assert.equal((await rawPost(base, path, '{broken', 'application/json', room.hostToken)).status, 400);
      assert.equal((await rawPost(base, path, '{}', 'text/plain', room.hostToken)).status, 415);
      assert.equal((await rawPost(base, path, `{"name":"${'x'.repeat(2048)}"}`, 'application/json', room.hostToken)).status, 413);
      const unknown = await api(base, 'POST', `/api/rooms/ZZZZZZ/${action}`, { name: 'A' }, room.hostToken);
      assert.equal(unknown.status, 404);
      assert.equal(unknown.body.error, 'room_not_found');
      if (action !== 'join') {
        const foreign = await api(base, 'POST', path, { filters: FILTERS, gameId: 'x', vote: 'like' }, other.hostToken);
        assert.equal(foreign.status, 401);
        assert.equal(foreign.body.error, 'unauthorized');
        assert.equal((await api(base, 'POST', path, {})).status, 401);
      }
      assert.equal((await rawRequest(srv.port, `POST /api/rooms/%E0%A4%A/${action} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`)), 404);
    });
  }

  test('GET snapshot and events: unknown room, malformed code', async () => {
    assert.equal((await api(base, 'GET', '/api/rooms/ZZZZZZ')).status, 404);
    assert.equal((await api(base, 'GET', '/api/rooms/ZZZZZZ/events')).status, 404);
    assert.equal((await api(base, 'GET', '/api/rooms/../../etc/passwd')).status, 404);
    assert.equal(await rawRequest(srv.port, 'GET /api/rooms/%E0%A4%A HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'), 404);
    assert.equal(await rawRequest(srv.port, 'GET /api/rooms/%E0%A4%A/events HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'), 404);
  });

  test('vote with invalid payload and wrong game', async () => {
    const room = await createRoom();
    const started = await api(base, 'POST', `/api/rooms/${room.code}/start`, { filters: FILTERS }, room.hostToken);
    const invalid = await api(base, 'POST', `/api/rooms/${room.code}/vote`, { gameId: started.body.deck[0], vote: 'love' }, room.playerToken);
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error, 'invalid_vote');
    const wrong = await api(base, 'POST', `/api/rooms/${room.code}/vote`, { gameId: 'not-a-game', vote: 'like' }, room.playerToken);
    assert.equal(wrong.status, 409);
    assert.equal(wrong.body.error, 'not_current_game');
  });

  test('non-host gets 403 not_host on host actions', async () => {
    const room = await createRoom();
    const ana = await api(base, 'POST', `/api/rooms/${room.code}/join`, { name: 'Ana' });
    const res = await api(base, 'POST', `/api/rooms/${room.code}/start`, { filters: FILTERS }, ana.body.playerToken);
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'not_host');
  });

  test('malformed URL on static paths and garbage Host header', async () => {
    assert.equal(await rawRequest(srv.port, 'GET /%E0%A4%A HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'), 400);
    assert.equal(await rawRequest(srv.port, 'GET /healthz HTTP/1.1\r\nHost: <script>@@::!!\r\nConnection: close\r\n\r\n'), 400);
    assert.equal(await rawRequest(srv.port, 'GET //\\\\evil HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n') < 500, true);
  });

  test('wrong methods and unknown API paths', async () => {
    const room = await createRoom();
    const wrong = await api(base, 'GET', `/api/rooms/${room.code}/vote`);
    assert.equal(wrong.status, 405);
    assert.equal(wrong.headers.get('allow'), 'POST');
    assert.equal((await api(base, 'DELETE', `/api/rooms/${room.code}`)).status, 405);
    assert.equal((await api(base, 'PUT', '/index.html')).status, 405);
    const unknown = await api(base, 'GET', '/api/nope');
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error, 'not_found');
  });

  test('Steam proxy: allowlist and stubbed details', async () => {
    const ok = await api(base, 'GET', '/api/steam/1966720');
    assert.equal(ok.status, 200);
    assert.equal(ok.body.price.final, 999);
    const unknown = await api(base, 'GET', '/api/steam/123');
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error, 'unknown_game');
    assert.equal((await api(base, 'GET', '/api/steam/abc')).status, 404);
  });
});

describe('static files', () => {
  test('serves index, SPA fallback for /r/:code and security headers', async () => {
    const index = await fetch(`${base}/`);
    const html = await index.text();
    assert.equal(index.status, 200);
    assert.match(index.headers.get('content-security-policy') ?? '', /connect-src 'self'/);
    assert.equal(index.headers.get('x-content-type-options'), 'nosniff');
    const room = await fetch(`${base}/r/ABC234`);
    assert.equal(room.status, 200);
    assert.equal(await room.text(), html);
  });

  test('blocks traversal', async () => {
    const status = await rawRequest(srv.port, 'GET /..%2f..%2fpackage.json HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
    assert.ok(status === 403 || status === 404, String(status));
  });
});
