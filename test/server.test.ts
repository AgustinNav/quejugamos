import { after, afterEach, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { api, eventsPath, openRoomSse, rawPost, rawRequest, startTestServer } from './helpers.ts';
import type { SseClient, TestServer } from './helpers.ts';
import { GAMES } from '../public/games.js';

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

    const sse = await openRoomSse(base, room.code, room.playerToken);
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
    assert.equal(v1.body.myVote, 'like');
    assert.deepEqual(v1.body.currentVoters, [room.playerId]);
    const v2 = await api(base, 'POST', `/api/rooms/${room.code}/vote`, { gameId: first, vote: 'like' }, ana.body.playerToken);
    assert.equal(v2.body.index, 1);
    assert.deepEqual(v2.body.lastResult, { gameId: first, likes: 2, nopes: 0, played: 0, playedOut: false, match: true });
    assert.equal(v2.body.myVote, null, 'the card closed: no vote on the new open card');
    const { myVote: _ignored, ...v2Snapshot } = v2.body;

    const event = await sse.waitFor((e) => e.event === 'state' && JSON.parse(e.data).version === v2.body.version);
    const pushed = JSON.parse(event.data);
    assert.deepEqual(pushed, v2Snapshot);
    assert.ok(!event.data.includes(room.hostToken) && !event.data.includes(ana.body.playerToken));

    const snap = await api(base, 'GET', `/api/rooms/${room.code}`, undefined, ana.body.playerToken);
    assert.deepEqual(snap.body, v2Snapshot);

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
    const nonSteam = GAMES.filter((g) => !g.steamId).map((g) => g.id);
    for (const id of res.body.deck) assert.ok(nonSteam.includes(id), id);
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

  test('start validates playerCount (400) and an explicit count filters the deck', async () => {
    const room = await createRoom();
    for (const playerCount of [0, 33, 2.5, '4', true, [2], { n: 2 }]) {
      const res = await api(base, 'POST', `/api/rooms/${room.code}/start`, { filters: { ...FILTERS, playerCount } }, room.hostToken);
      assert.equal(res.status, 400, JSON.stringify(playerCount));
      assert.equal(res.body.error, 'invalid_filters');
    }
    await assertAlive();
    const { fitsGroup: _legacy, ...modern } = FILTERS;
    const res = await api(base, 'POST', `/api/rooms/${room.code}/start`, { filters: { ...modern, playerCount: 8 } }, room.hostToken);
    assert.equal(res.status, 200);
    assert.equal(res.body.filters.playerCount, 8);
    const byId = new Map(GAMES.map((g) => [g.id, g]));
    for (const id of res.body.deck) {
      const [min, max] = byId.get(id)!.players;
      assert.ok(min <= 8 && max >= 8, id);
    }
  });

  test('kick: host removes a ghost player, the card closes and SSE gets the new snapshot', async () => {
    const room = await createRoom();
    const ana = (await api(base, 'POST', `/api/rooms/${room.code}/join`, { name: 'Ana' })).body;
    const ghost = (await api(base, 'POST', `/api/rooms/${room.code}/join`, { name: 'Ana2' })).body;
    const started = await api(base, 'POST', `/api/rooms/${room.code}/start`, { filters: FILTERS }, room.hostToken);
    const first = started.body.deck[0];
    await api(base, 'POST', `/api/rooms/${room.code}/vote`, { gameId: first, vote: 'like' }, room.playerToken);
    await api(base, 'POST', `/api/rooms/${room.code}/vote`, { gameId: first, vote: 'like' }, ana.playerToken);

    const sse = await openRoomSse(base, room.code, room.hostToken);
    sseClients.push(sse);
    await sse.waitFor((e) => e.event === 'state');

    const kicked = await api(base, 'POST', `/api/rooms/${room.code}/kick`, { playerId: ghost.playerId }, room.hostToken);
    assert.equal(kicked.status, 200);
    assert.ok(!kicked.body.players.some((p: { id: string }) => p.id === ghost.playerId));
    assert.equal(kicked.body.index, 1);
    assert.deepEqual(kicked.body.lastResult, { gameId: first, likes: 2, nopes: 0, played: 0, playedOut: false, match: true });

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

  test('played vote: hidden while open, /me returns it, majority freezes playedOut, undo reopens it', async () => {
    const room = await createRoom();
    const ana = (await api(base, 'POST', `/api/rooms/${room.code}/join`, { name: 'Ana' })).body;
    const started = await api(base, 'POST', `/api/rooms/${room.code}/start`, { filters: FILTERS }, room.hostToken);
    const first = started.body.deck[0];
    const sse = await openRoomSse(base, room.code, room.hostToken);
    sseClients.push(sse);
    await sse.waitFor((e) => e.event === 'state');

    const hostVote = await api(base, 'POST', `/api/rooms/${room.code}/vote`, { gameId: first, vote: 'played' }, room.playerToken);
    assert.equal(hostVote.status, 200);
    assert.equal(hostVote.body.myVote, 'played');
    assert.deepEqual(hostVote.body.currentVoters, [room.playerId]);
    assert.equal(hostVote.body.votes[first], undefined, 'open-card votes stay private');
    const me = await api(base, 'GET', `/api/rooms/${room.code}/me`, undefined, room.playerToken);
    assert.deepEqual(me.body, { playerId: room.playerId, gameId: first, vote: 'played' });
    const outsider = await api(base, 'GET', `/api/rooms/${room.code}`);
    assert.ok(!JSON.stringify(outsider.body).includes('played'), 'non-members never see votes');
    const memberView = await api(base, 'GET', `/api/rooms/${room.code}`, undefined, ana.playerToken);
    assert.ok(!JSON.stringify(memberView.body.votes).includes('played'));

    const anaVote = await api(base, 'POST', `/api/rooms/${room.code}/vote`, { gameId: first, vote: 'played' }, ana.playerToken);
    const expected = { gameId: first, likes: 0, nopes: 0, played: 2, playedOut: true, match: false };
    assert.deepEqual(anaVote.body.lastResult, expected);
    assert.deepEqual(anaVote.body.results, { [first]: expected });
    assert.equal(anaVote.body.myVote, null);
    assert.equal(anaVote.body.votes[first][ana.playerId], 'played');
    const event = await sse.waitFor((e) => e.event === 'state' && JSON.parse(e.data).version === anaVote.body.version);
    assert.deepEqual(JSON.parse(event.data).lastResult, expected);

    const undo = await api(base, 'POST', `/api/rooms/${room.code}/undo`, {}, room.hostToken);
    assert.equal(undo.body.index, 0);
    assert.deepEqual(undo.body.results, {});
    const log = srv.logs.map((l) => JSON.parse(l)).find((l) => l.event === 'card_closed' && l.roomCode === room.code);
    assert.deepEqual(log, { severity: 'INFO', event: 'card_closed', roomCode: room.code, gameId: first, likes: 0, nopes: 0, played: 2, playedOut: true, match: false, finished: false });
  });

  test('start: unknown filter fields such as the retired excludeGameIds are ignored', async () => {
    const room = await createRoom();
    const all = await api(base, 'POST', `/api/rooms/${room.code}/start`, { filters: FILTERS }, room.hostToken);
    const other = await createRoom();
    const res = await api(base, 'POST', `/api/rooms/${other.code}/start`, { filters: { ...FILTERS, excludeGameIds: [all.body.deck[0]] } }, other.hostToken);
    assert.equal(res.status, 200);
    assert.equal(res.body.deck.length, all.body.deck.length, 'nothing is excluded');
    assert.ok(!('excludeGameIds' in res.body.filters));
    const log = srv.logs.map((l) => JSON.parse(l)).find((l) => l.event === 'game_started' && l.roomCode === other.code);
    assert.ok(!('excludedGames' in log));
  });

  test('open-card votes: member GET and SSE only show who voted; /me returns your own vote', async () => {
    const room = await createRoom();
    const ana = (await api(base, 'POST', `/api/rooms/${room.code}/join`, { name: 'Ana' })).body;
    const started = await api(base, 'POST', `/api/rooms/${room.code}/start`, { filters: FILTERS }, room.hostToken);
    const first = started.body.deck[0];
    const sse = await openRoomSse(base, room.code, room.hostToken);
    sseClients.push(sse);
    const voted = await api(base, 'POST', `/api/rooms/${room.code}/vote`, { gameId: first, vote: 'nope' }, ana.playerToken);
    assert.equal(voted.body.myVote, 'nope');

    const pushed = await sse.waitFor((e) => e.event === 'state' && JSON.parse(e.data).version === voted.body.version);
    const snap = await api(base, 'GET', `/api/rooms/${room.code}`, undefined, room.hostToken);
    for (const body of [snap.body, JSON.parse(pushed.data)]) {
      assert.deepEqual(body.votes, {});
      assert.deepEqual(body.currentVoters, [ana.playerId]);
      assert.equal(body.myVote, undefined);
      assert.ok(!JSON.stringify(body).includes('nope'), 'open-card vote leaked');
    }

    const me = await api(base, 'GET', `/api/rooms/${room.code}/me`, undefined, ana.playerToken);
    assert.equal(me.status, 200);
    assert.deepEqual(me.body, { playerId: ana.playerId, gameId: first, vote: 'nope' });
    const hostMe = await api(base, 'GET', `/api/rooms/${room.code}/me`, undefined, room.hostToken);
    assert.deepEqual(hostMe.body, { playerId: room.playerId, gameId: first, vote: null });
    assert.equal((await api(base, 'GET', `/api/rooms/${room.code}/me`)).status, 401);
    const other = await createRoom();
    assert.equal((await api(base, 'GET', `/api/rooms/${room.code}/me`, undefined, other.hostToken)).status, 401);
    assert.equal((await api(base, 'GET', '/api/rooms/ZZZZZZ/me', undefined, ana.playerToken)).status, 404);
    assert.equal((await api(base, 'POST', `/api/rooms/${room.code}/me`, {}, ana.playerToken)).status, 405);
    await assertAlive();
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
    assert.equal((await headRequest(srv.port, `/api/rooms/${room.code}/events`)).status, 401, 'HEAD needs a ticket too');
    const { status, ended } = await headRequest(srv.port, await eventsPath(base, room.code, room.hostToken));
    assert.equal(status, 200);
    assert.ok(ended, 'HEAD response did not end');
    assert.equal(srv.hub.connectionCount(room.code), 0);
    assert.equal((await headRequest(srv.port, '/api/rooms/ZZZZZZ/events')).status, 404);
  });

  test('SSE receives closed when the room expires', async () => {
    const room = await createRoom();
    const sse = await openRoomSse(base, room.code, room.hostToken);
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

  const POSTS = ['join', 'start', 'vote', 'next', 'undo', 'kick', 'finish', 'close', 'stream-ticket'];

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
      // Own client IP per action: these 404s would otherwise add up to the room-miss limit (20/min).
      const missIp = `10.8.0.${POSTS.indexOf(action) + 1}`;
      const unknown = await fetch(`${base}/api/rooms/ZZZZZZ/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${room.hostToken}`, 'X-Forwarded-For': missIp },
        body: JSON.stringify({ name: 'A' }),
      });
      assert.equal(unknown.status, 404);
      assert.equal(((await unknown.json()) as { error: string }).error, 'room_not_found');
      if (action !== 'join') {
        const foreign = await api(base, 'POST', path, { filters: FILTERS, gameId: 'x', vote: 'like' }, other.hostToken);
        assert.equal(foreign.status, 401);
        assert.equal(foreign.body.error, 'unauthorized');
        assert.equal((await api(base, 'POST', path, {})).status, 401);
      }
      assert.equal((await rawRequest(srv.port, `POST /api/rooms/%E0%A4%A/${action} HTTP/1.1\r\nHost: localhost\r\nX-Forwarded-For: ${missIp}\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`)), 404);
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

  test('POST /skip no longer exists', async () => {
    const room = await createRoom();
    const res = await api(base, 'POST', `/api/rooms/${room.code}/skip`, { gameId: 'valheim' }, room.playerToken);
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'not_found');
  });

  test('vote: values outside like/nope/played/null are 400 and the process survives; null clears a played vote', async () => {
    const room = await createRoom();
    const started = await api(base, 'POST', `/api/rooms/${room.code}/start`, { filters: FILTERS }, room.hostToken);
    const gameId = started.body.deck[0];
    const path = `/api/rooms/${room.code}/vote`;
    for (const vote of ['PLAYED', 'skip', 'Played ', 1, true, {}, ['played']]) {
      const res = await api(base, 'POST', path, { gameId, vote }, room.playerToken);
      assert.equal(res.status, 400, JSON.stringify(vote));
      assert.equal(res.body.error, 'invalid_vote');
    }
    assert.equal((await api(base, 'POST', path, { gameId, vote: undefined }, room.playerToken)).status, 400);
    await api(base, 'POST', `/api/rooms/${room.code}/join`, { name: 'Ana' });
    assert.equal((await api(base, 'POST', path, { gameId, vote: 'played' }, room.playerToken)).body.myVote, 'played');
    const cleared = await api(base, 'POST', path, { gameId, vote: null }, room.playerToken);
    assert.equal(cleared.body.myVote, null);
    assert.deepEqual(cleared.body.currentVoters, []);
  });

  test('finish: lobby, non-host, finished, odd bodies and GET', async () => {
    const room = await createRoom();
    const ana = (await api(base, 'POST', `/api/rooms/${room.code}/join`, { name: 'Ana' })).body;
    const path = `/api/rooms/${room.code}/finish`;
    const lobby = await api(base, 'POST', path, {}, room.hostToken);
    assert.equal(lobby.status, 409);
    assert.equal(lobby.body.error, 'not_voting');
    await api(base, 'POST', `/api/rooms/${room.code}/start`, { filters: FILTERS }, room.hostToken);
    const notHost = await api(base, 'POST', path, {}, ana.playerToken);
    assert.equal(notHost.status, 403);
    assert.equal(notHost.body.error, 'not_host');
    assert.equal((await api(base, 'GET', path)).status, 405);
    assert.equal((await rawPost(base, path, '{"', 'application/json', room.hostToken)).status, 400);
    assert.equal((await rawPost(base, path, '{}', 'application/json', 'x'.repeat(300))).status, 401);
    assert.equal((await api(base, 'GET', `/api/rooms/${room.code}`)).body.phase, 'voting');
    // The body is ignored: any valid JSON finishes, like next/undo.
    assert.equal((await api(base, 'POST', path, [1, 2], room.hostToken)).status, 200);
    const again = await api(base, 'POST', path, {}, room.hostToken);
    assert.equal(again.status, 409);
    assert.equal(again.body.error, 'not_voting');
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

  test('NUL byte after decoding is a 400, not a 500 with a stack trace', async () => {
    const res = await api(base, 'GET', '/a%00b');
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'bad_request');
    assert.equal((await api(base, 'GET', '/vendor/%00.js')).status, 400);
    assert.ok(!srv.logs.some((l) => JSON.parse(l).severity === 'ERROR'), 'unexpected ERROR log');
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

  test('hls.js is vendored and the CSP allows no third-party script origin', async () => {
    const index = await fetch(`${base}/`);
    const csp = index.headers.get('content-security-policy') ?? '';
    assert.match(csp, /script-src 'self'(;|$)/);
    assert.ok(!csp.includes('jsdelivr'), csp);
    assert.match(await index.text(), /<script src="\/vendor\/hls\.min\.js"/);
    const hls = await fetch(`${base}/vendor/hls.min.js`);
    assert.equal(hls.status, 200);
    assert.match(hls.headers.get('content-type') ?? '', /^text\/javascript/);
    await hls.arrayBuffer();
  });

  test('blocks traversal', async () => {
    const status = await rawRequest(srv.port, 'GET /..%2f..%2fpackage.json HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
    assert.ok(status === 403 || status === 404, String(status));
  });
});
