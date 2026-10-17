// Client-side SuperLike logic that has no DOM: availability, the swipe-up fling, optimistic rollback,
// ranking order (counts double) and the export.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { superlikeAvailable, superlikeFrozen } from '../public/js/superlike.js';
import { isSuperlikeFling, SUPERLIKE_MIN_DY, SUPERLIKE_VELOCITY, velocityY } from '../public/js/gesture.js';
import { reconcileVote } from '../public/js/reconcile.js';
import { rankScore } from '../public/js/ranking-data.js';
import { buildExport, formatRankingText, rankedByVotes } from '../public/js/ranking-export.js';
import { errorMessage } from '../public/js/errors.js';

const closed = (gameId: string, likes: number, superlikes = 0, superlikedBy: string[] = [], o: Record<string, unknown> = {}) =>
  ({ gameId, likes, superlikes, superlikedBy, nopes: 0, played: 0, playedOut: false, match: false, ...o });

describe('superlike availability (mirrors the server rule)', () => {
  const state = { votes: { a: { p1: 'superlike', p2: 'like' }, b: { p1: 'like' } } };

  test('a frozen superlike on a closed card spends it', () => {
    assert.equal(superlikeFrozen(state, 'p1'), true);
    assert.equal(superlikeFrozen(state, 'p2'), false);
    assert.equal(superlikeAvailable({ state, playerId: 'p1', myVote: null }), false);
    assert.equal(superlikeAvailable({ state, playerId: 'p2', myVote: null }), true);
  });

  test('a superlike cast on the open card can be kept or changed', () => {
    assert.equal(superlikeAvailable({ state: { votes: {} }, playerId: 'p1', myVote: 'superlike' }), true);
  });

  test('an optimistic advance carrying a superlike spends it before the server confirms', () => {
    assert.equal(superlikeAvailable({ state: { votes: {} }, playerId: 'p1', myVote: null, pendingElsewhere: true }), false);
  });

  test('tolerates a missing state or votes', () => {
    assert.equal(superlikeAvailable({ state: undefined, playerId: 'p1', myVote: null }), true);
    assert.equal(superlikeAvailable({ state: {}, playerId: 'p1', myVote: null }), true);
  });
});

describe('swipe-up fling', () => {
  const fling = { dx: 10, dy: -SUPERLIKE_MIN_DY - 20, vy: -(SUPERLIKE_VELOCITY + 0.5) };

  test('a long, fast, mostly vertical upward move is a superlike', () => {
    assert.equal(isSuperlikeFling(fling), true);
  });

  test('too short, too slow, downward or diagonal moves are not', () => {
    assert.equal(isSuperlikeFling({ ...fling, dy: -SUPERLIKE_MIN_DY + 1 }), false);
    assert.equal(isSuperlikeFling({ ...fling, vy: -(SUPERLIKE_VELOCITY - 0.1) }), false);
    assert.equal(isSuperlikeFling({ dx: 0, dy: 300, vy: 2 }), false);
    assert.equal(isSuperlikeFling({ ...fling, dx: 200 }), false);
  });

  test('if the page itself scrolled during the gesture it was a scroll, however fast', () => {
    assert.equal(isSuperlikeFling({ ...fling, scrolled: true }), false);
  });

  test('velocityY is negative for an upward move and uses only the recent samples', () => {
    const samples = [{ t: 0, y: 500 }, { t: 500, y: 480 }, { t: 560, y: 400 }, { t: 600, y: 300 }];
    assert.ok(velocityY(samples) < -SUPERLIKE_VELOCITY);
    assert.equal(velocityY([{ t: 0, y: 5 }]), 0);
  });
});

describe('optimistic superlike', () => {
  const optimistic = { fromIndex: 2, toIndex: 3, baseVersion: 10, vote: 'superlike' };

  test('a 409 superlike_used (request error, no snapshot) rolls the advance back', () => {
    assert.equal(reconcileVote(optimistic, null), 'rollback');
  });

  test('the confirming snapshot of a superlike that closed the card is accepted', () => {
    assert.equal(reconcileVote(optimistic, { version: 11, index: 3 }), 'confirm');
  });

  test('the user-facing copy for the rejection exists', () => {
    assert.equal(errorMessage('superlike_used'), 'Ya usaste tu SuperLike en esta sala');
  });
});

describe('ranking counts a superlike double', () => {
  const nameOf = (id: string) => id.toUpperCase();
  const players = [{ id: 'p1', name: 'Agus Navarro' }, { id: 'p2', name: 'Juli' }, { id: 'p3', name: 'Pedro' }];
  const state = (results: Record<string, unknown>, votes: Record<string, unknown> = {}) => ({
    code: 'K7Q2MX', phase: 'finished', players, deck: Object.keys(results), index: Object.keys(results).length, votes, results,
  });

  test('rankScore = likes + superlikes, and tolerates results without the field', () => {
    assert.equal(rankScore({ likes: 3, superlikes: 1 }), 4);
    assert.equal(rankScore({ likes: 3 }), 3);
  });

  test('a card with 2 likes + 1 superlike (score 4) outranks a plain 3-like card', () => {
    const s = state({ plain: closed('plain', 3), star: closed('star', 3, 1, ['p1']) });
    assert.deepEqual(rankedByVotes(s).map((r: { gameId: string }) => r.gameId), ['star', 'plain']);
  });

  test('ties keep the old tie-breaks: fewer nopes first', () => {
    const s = state({ a: closed('a', 2, 0, [], { nopes: 1 }), b: closed('b', 2, 0, [], { nopes: 0 }) });
    assert.deepEqual(rankedByVotes(s).map((r: { gameId: string }) => r.gameId), ['b', 'a']);
  });

  test('the export always shows the star count, names only with the opt-in', () => {
    const s = state({ star: closed('star', 2, 1, ['p1', 'p3']) }, { star: { p1: 'superlike', p2: 'like', p3: 'superlike' } });
    const anon = buildExport(s, { nameOf });
    assert.equal(anon.items[0].superlikes, 1);
    assert.deepEqual(anon.items[0].superlikers, []);
    assert.deepEqual(anon.items[0].likers, []);
    assert.ok(formatRankingText(anon).includes('2 👍 · ⭐ 1'));
    assert.ok(!formatRankingText(anon).includes('Agus'));
    const named = buildExport(s, { nameOf, includeNames: true });
    assert.deepEqual(named.items[0].superlikers, ['Agus', 'Pedro']);
    assert.ok(formatRankingText(named).includes('(Juli · ⭐ Agus, Pedro)'));
  });

  test('a card without superlikes prints exactly as before', () => {
    const s = state({ plain: closed('plain', 3) });
    assert.ok(formatRankingText(buildExport(s, { nameOf })).includes('1. PLAIN — 3 👍\n'));
  });
});
