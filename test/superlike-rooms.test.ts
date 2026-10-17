// SuperLike domain rules (src/rooms.ts): one per player per room, freed by change / clear / undo / finish / kick.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomError, RoomStore } from '../src/rooms.ts';
import type { Filters } from '../src/rooms.ts';

const FILTERS: Filters = { platforms: ['PC'], maxPrice: null, fitsGroup: true, playerCount: null };
const DECK = ['a', 'b', 'c'];

/** Room in voting with host + ana + bob (3 players), deck a, b, c. */
function votingRoom() {
  let counter = 0;
  const store = new RoomStore({
    now: () => 1_000_000,
    randomInt: (max) => counter++ % max,
    uuid: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`,
  });
  const host = store.create('Host', '1.1.1.1');
  const ana = store.join(host.code, 'Ana');
  const bob = store.join(host.code, 'Bob');
  store.start(host.code, host.hostToken, FILTERS, () => [...DECK]);
  return { store, host, ana, bob, code: host.code };
}
type Ctx = ReturnType<typeof votingRoom>;

function expectError(fn: () => unknown, status: number, code: string) {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof RoomError, `expected RoomError, got ${err}`);
    assert.equal(err.status, status);
    assert.equal(err.code, code);
    return true;
  });
}

const available = (r: Ctx, who: { playerToken: string }) => r.store.currentVote(r.code, who.playerToken).superlikeAvailable;

/** Everyone votes `a` (ana superlikes it) so it closes and the room moves on to `b`. */
function closeAWithAnaSuperlike(r: Ctx) {
  r.store.vote(r.code, r.ana.playerToken, 'a', 'superlike');
  r.store.vote(r.code, r.bob.playerToken, 'a', 'nope');
  return r.store.vote(r.code, r.host.playerToken, 'a', 'like');
}

describe('superlike vote', () => {
  test('is private while the card is open, changeable and clearable like the other values', () => {
    const r = votingRoom();
    const snap = r.store.vote(r.code, r.ana.playerToken, 'a', 'superlike');
    assert.deepEqual(snap.currentVoters, [r.ana.playerId]);
    assert.equal(snap.votes.a, undefined);
    assert.equal(r.store.currentVote(r.code, r.ana.playerToken).vote, 'superlike');
    r.store.vote(r.code, r.ana.playerToken, 'a', 'like');
    assert.equal(r.store.currentVote(r.code, r.ana.playerToken).vote, 'like');
    r.store.vote(r.code, r.ana.playerToken, 'a', 'superlike');
    assert.deepEqual(r.store.vote(r.code, r.ana.playerToken, 'a', null).currentVoters, []);
  });

  test('repeating the same superlike on the open card is a no-op (no version bump)', () => {
    const r = votingRoom();
    r.store.vote(r.code, r.ana.playerToken, 'a', 'superlike');
    const version = r.store.snapshot(r.code).version;
    r.store.vote(r.code, r.ana.playerToken, 'a', 'superlike');
    assert.equal(r.store.snapshot(r.code).version, version);
  });

  test('one per player per room: a second one on another card is 409 superlike_used and changes nothing', () => {
    const r = votingRoom();
    closeAWithAnaSuperlike(r);
    assert.equal(available(r, r.ana), false);
    const version = r.store.snapshot(r.code).version;
    expectError(() => r.store.vote(r.code, r.ana.playerToken, 'b', 'superlike'), 409, 'superlike_used');
    assert.equal(r.store.snapshot(r.code).version, version);
    assert.equal(r.store.currentVote(r.code, r.ana.playerToken).vote, null);
    // The other values keep working, and other players still have theirs.
    r.store.vote(r.code, r.ana.playerToken, 'b', 'like');
    assert.equal(available(r, r.bob), true);
    r.store.vote(r.code, r.bob.playerToken, 'b', 'superlike');
  });

  test('a superlike on the open card counts as used for availability but can be changed', () => {
    const r = votingRoom();
    r.store.vote(r.code, r.ana.playerToken, 'a', 'superlike');
    assert.equal(available(r, r.ana), false);
    r.store.vote(r.code, r.ana.playerToken, 'a', 'like');
    assert.equal(available(r, r.ana), true);
  });

  test('clearing it on the open card frees it for the next card', () => {
    const r = votingRoom();
    r.store.vote(r.code, r.ana.playerToken, 'a', 'superlike');
    r.store.vote(r.code, r.ana.playerToken, 'a', null);
    r.store.next(r.code, r.host.hostToken);
    r.store.vote(r.code, r.ana.playerToken, 'b', 'superlike');
    assert.equal(r.store.currentVote(r.code, r.ana.playerToken).vote, 'superlike');
  });

  test('undo reopens the card with no votes, so its superlike is available again', () => {
    const r = votingRoom();
    closeAWithAnaSuperlike(r);
    assert.equal(available(r, r.ana), false);
    r.store.undo(r.code, r.host.hostToken);
    assert.equal(available(r, r.ana), true);
    r.store.vote(r.code, r.ana.playerToken, 'a', 'like');
    r.store.vote(r.code, r.bob.playerToken, 'a', 'like');
    r.store.vote(r.code, r.host.playerToken, 'a', 'like');
    r.store.vote(r.code, r.ana.playerToken, 'b', 'superlike');
  });

  test('finishing early drops the open card votes and frees a superlike cast there', () => {
    const r = votingRoom();
    r.store.next(r.code, r.host.hostToken);
    r.store.vote(r.code, r.ana.playerToken, 'b', 'superlike');
    assert.equal(available(r, r.ana), false);
    const done = r.store.finish(r.code, r.host.hostToken);
    assert.equal(done.votes.b, undefined);
    r.store.undo(r.code, r.host.hostToken); // resume: the discarded card comes back without votes
    assert.equal(available(r, r.ana), true);
    r.store.vote(r.code, r.ana.playerToken, 'b', 'superlike');
  });

  test('the closed result counts it in likes and superlikes, lists who gave it, and stays frozen for late joiners', () => {
    const r = votingRoom();
    const snap = closeAWithAnaSuperlike(r);
    assert.deepEqual(snap.lastResult, {
      gameId: 'a', likes: 2, superlikes: 1, superlikedBy: [r.ana.playerId], nopes: 1, played: 0, playedOut: false, match: false,
    });
    assert.equal(snap.votes.a[r.ana.playerId], 'superlike');
    const late = r.store.join(r.code, 'Late');
    assert.deepEqual(late.snapshot.results.a, snap.lastResult);
  });

  test('superlikedBy is sorted by player id whatever the voting order', () => {
    const r = votingRoom();
    r.store.vote(r.code, r.bob.playerToken, 'a', 'superlike');
    r.store.vote(r.code, r.host.playerToken, 'a', 'superlike');
    const snap = r.store.vote(r.code, r.ana.playerToken, 'a', 'superlike');
    assert.deepEqual(snap.lastResult?.superlikedBy, [r.ana.playerId, r.bob.playerId, r.host.playerId].sort());
  });

  test('a card everyone liked or superliked is a match; superlikes are never nopes or played', () => {
    const r = votingRoom();
    r.store.vote(r.code, r.ana.playerToken, 'a', 'superlike');
    r.store.vote(r.code, r.bob.playerToken, 'a', 'like');
    const snap = r.store.vote(r.code, r.host.playerToken, 'a', 'superlike');
    assert.equal(snap.lastResult?.match, true);
    assert.equal(snap.lastResult?.likes, 3);
    assert.equal(snap.lastResult?.superlikes, 2);
    assert.equal(snap.lastResult?.nopes, 0);
    assert.equal(snap.lastResult?.playedOut, false);
  });

  test('playedOut still counts a superlike as a cast vote: 1 superlike + 2 played is played out', () => {
    const r = votingRoom();
    r.store.vote(r.code, r.ana.playerToken, 'a', 'superlike');
    r.store.vote(r.code, r.bob.playerToken, 'a', 'played');
    const snap = r.store.vote(r.code, r.host.playerToken, 'a', 'played');
    assert.equal(snap.lastResult?.playedOut, true);
    assert.equal(snap.lastResult?.match, false);
  });

  test('a superlike counts toward auto-advance as the last vote', () => {
    const r = votingRoom();
    r.store.vote(r.code, r.bob.playerToken, 'a', 'nope');
    r.store.vote(r.code, r.host.playerToken, 'a', 'nope');
    assert.equal(r.store.vote(r.code, r.ana.playerToken, 'a', 'superlike').index, 1);
  });

  test('kick: the open card superlike of the kicked player is dropped; a closed one stays frozen in the result', () => {
    const r = votingRoom();
    closeAWithAnaSuperlike(r);
    r.store.vote(r.code, r.bob.playerToken, 'b', 'superlike');
    r.store.kick(r.code, r.host.hostToken, r.bob.playerId);
    assert.equal(r.store.snapshot(r.code).votes.b, undefined);
    r.store.kick(r.code, r.host.hostToken, r.ana.playerId);
    const frozen = r.store.snapshot(r.code).results.a;
    assert.deepEqual(frozen.superlikedBy, [r.ana.playerId]);
    assert.equal(frozen.superlikes, 1);
    expectError(() => r.store.vote(r.code, r.ana.playerToken, 'b', 'superlike'), 401, 'unauthorized');
  });

  test('rejects look-alike values with 400 invalid_vote', () => {
    const r = votingRoom();
    for (const bad of ['SUPERLIKE', 'super', 'superlike ', 'star']) {
      expectError(() => r.store.vote(r.code, r.ana.playerToken, 'a', bad), 400, 'invalid_vote');
    }
  });
});
