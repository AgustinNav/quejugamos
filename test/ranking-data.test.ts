import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  closedResults, finishedEarly, playedOutResults, rankedResults, remainingCount, unvotedGameIds,
} from '../public/js/ranking-data.js';

const result = (gameId: string, playedOut = false) => ({ gameId, likes: 1, nopes: 0, played: playedOut ? 2 : 0, playedOut, match: false });

function state(overrides: Record<string, unknown> = {}) {
  return {
    phase: 'finished',
    deck: ['a', 'b', 'c', 'd'],
    index: 2,
    results: { a: result('a'), b: result('b', true) },
    ...overrides,
  };
}

describe('ranking-data', () => {
  test('finishedEarly: finished with cards left in the deck', () => {
    assert.equal(finishedEarly(state()), true);
    assert.equal(finishedEarly(state({ index: 4 })), false);
    assert.equal(finishedEarly(state({ phase: 'voting' })), false);
  });

  test('splits closed cards into ranked and played-out, in deck order', () => {
    assert.deepEqual(closedResults(state()).map((r: { gameId: string }) => r.gameId), ['a', 'b']);
    assert.deepEqual(rankedResults(state()).map((r: { gameId: string }) => r.gameId), ['a']);
    assert.deepEqual(playedOutResults(state()).map((r: { gameId: string }) => r.gameId), ['b']);
  });

  test('cards without a frozen result are not closed', () => {
    assert.deepEqual(closedResults(state({ results: { a: result('a') } })).map((r: { gameId: string }) => r.gameId), ['a']);
  });

  test('unvotedGameIds: the discarded open card and the rest, only after an early finish', () => {
    assert.deepEqual(unvotedGameIds(state()), ['c', 'd']);
    assert.deepEqual(unvotedGameIds(state({ index: 4 })), []);
    assert.deepEqual(unvotedGameIds(state({ phase: 'voting' })), []);
  });

  test('remainingCount includes the open card', () => {
    assert.equal(remainingCount(state({ phase: 'voting', index: 1 })), 3);
    assert.equal(remainingCount(state({ index: 4 })), 0);
  });
});
