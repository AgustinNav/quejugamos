// SuperLike over HTTP: validation, the 409 rule, per-caller fields, and that the process survives bad input.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { api, openRoomSse, rawPost, startTestServer } from './helpers.ts';
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

async function assertAlive() {
  assert.equal((await api(base, 'GET', '/healthz')).status, 200);
}

let ipCounter = 0;
async function createRoom() {
  ipCounter += 1;
  const res = await fetch(`${base}/api/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.31.0.${ipCounter}` },
    body: JSON.stringify({ hostName: 'Host' }),
  });
  assert.equal(res.status, 201);
  return res.json() as Promise<{ code: string; hostToken: string; playerToken: string; playerId: string }>;
}

/** Host + Ana in a voting room; returns the first two deck ids. */
async function votingRoom() {
  const room = await createRoom();
  const ana = (await api(base, 'POST', `/api/rooms/${room.code}/join`, { name: 'Ana' })).body as { playerToken: string; playerId: string };
  const started = await api(base, 'POST', `/api/rooms/${room.code}/start`, { filters: FILTERS }, room.hostToken);
  const [first, second] = started.body.deck as string[];
  return { room, ana, first, second, path: `/api/rooms/${room.code}/vote` };
}

describe('superlike over HTTP', () => {
  test('is accepted; the response carries myVote and superlikeAvailable for the caller only', async () => {
    const { room, ana, first, path } = await votingRoom();
    const sse = await openRoomSse(base, room.code, room.playerToken);
    sseClients.push(sse);
    await sse.waitFor((e) => e.event === 'state');
    const res = await api(base, 'POST', path, { gameId: first, vote: 'superlike' }, ana.playerToken);
    assert.equal(res.status, 200);
    assert.equal(res.body.myVote, 'superlike');
    assert.equal(res.body.superlikeAvailable, false, 'a superlike on the open card counts as used until changed');
    assert.equal(res.body.votes[first], undefined, 'open-card votes stay hidden');
    const me = await api(base, 'GET', `/api/rooms/${room.code}/me`, undefined, ana.playerToken);
    assert.deepEqual(me.body, { playerId: ana.playerId, gameId: first, vote: 'superlike', superlikeAvailable: false });
    const hostMe = await api(base, 'GET', `/api/rooms/${room.code}/me`, undefined, room.hostToken);
    assert.equal(hostMe.body.superlikeAvailable, true);
    // The SSE snapshot is the same for everyone: no per-caller field may leak into it.
    const pushed = JSON.parse((await sse.waitFor((e) => e.event === 'state' && JSON.parse(e.data).version === res.body.version)).data);
    assert.equal('superlikeAvailable' in pushed, false);
    assert.equal('myVote' in pushed, false);
  });

  test('a second superlike on another card is 409 superlike_used; the room is untouched and still votable', async () => {
    const { room, ana, first, second, path } = await votingRoom();
    await api(base, 'POST', path, { gameId: first, vote: 'superlike' }, ana.playerToken);
    const closed = await api(base, 'POST', path, { gameId: first, vote: 'like' }, room.playerToken);
    assert.equal(closed.body.index, 1);
    assert.deepEqual(closed.body.lastResult.superlikedBy, [ana.playerId]);
    assert.equal(closed.body.lastResult.superlikes, 1);
    assert.equal(closed.body.lastResult.likes, 2);
    const refused = await api(base, 'POST', path, { gameId: second, vote: 'superlike' }, ana.playerToken);
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error, 'superlike_used');
    const after = await api(base, 'GET', `/api/rooms/${room.code}`, undefined, ana.playerToken);
    assert.equal(after.body.version, closed.body.version);
    const ok = await api(base, 'POST', path, { gameId: second, vote: 'like' }, ana.playerToken);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.superlikeAvailable, false);
    await assertAlive();
  });

  test('card_closed logs the superlike count and no ids or names', async () => {
    const { room, ana, first, path } = await votingRoom();
    await api(base, 'POST', path, { gameId: first, vote: 'superlike' }, ana.playerToken);
    await api(base, 'POST', path, { gameId: first, vote: 'nope' }, room.playerToken);
    const line = srv.logs.map((l) => JSON.parse(l)).find((l) => l.event === 'card_closed' && l.roomCode === room.code);
    assert.equal(line.superlikes, 1);
    assert.equal(line.likes, 1);
    assert.ok(!JSON.stringify(line).includes(ana.playerId));
  });

  test('invalid values are 400 invalid_vote and the process survives', async () => {
    const { room, first, path } = await votingRoom();
    for (const vote of ['SUPERLIKE', 'super_like', 'star', 2, ['superlike'], { v: 'superlike' }]) {
      const res = await api(base, 'POST', path, { gameId: first, vote }, room.playerToken);
      assert.equal(res.status, 400, JSON.stringify(vote));
      assert.equal(res.body.error, 'invalid_vote');
    }
    await assertAlive();
  });

  test('malformed requests carrying a superlike stay 4xx and the process survives', async () => {
    const { room, first, path } = await votingRoom();
    const other = await createRoom();
    const good = JSON.stringify({ gameId: first, vote: 'superlike' });
    assert.equal((await rawPost(base, path, '{"gameId":"x","vote":"superlike"', 'application/json', room.playerToken)).status, 400);
    assert.equal((await rawPost(base, path, good, 'text/plain', room.playerToken)).status, 415);
    assert.equal((await rawPost(base, path, JSON.stringify({ gameId: first, vote: 'superlike', pad: 'x'.repeat(2048) }), 'application/json', room.playerToken)).status, 413);
    const foreign = await rawPost(base, path, good, 'application/json', other.playerToken);
    assert.equal(foreign.status, 401);
    assert.equal((await rawPost(base, path, good, 'application/json')).status, 401);
    // None of those registered a vote.
    const me = await api(base, 'GET', `/api/rooms/${room.code}/me`, undefined, room.playerToken);
    assert.equal(me.body.vote, null);
    await assertAlive();
  });
});
