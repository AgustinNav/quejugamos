import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { closeKey, createOnce, reconcileVote } from '../public/js/reconcile.js';

const optimistic = { fromIndex: 2, toIndex: 3, baseVersion: 10 };
const snap = (version: number, index: number) => ({ version, index, phase: 'voting' });

describe('reconcileVote', () => {
  test('confirms the POST response that closed the card', () => {
    assert.equal(reconcileVote(optimistic, snap(11, 3)), 'confirm');
  });

  test('confirms via SSE first; the late POST (optimistic already cleared) is ignored', () => {
    assert.equal(reconcileVote(optimistic, snap(11, 3)), 'confirm');
    assert.equal(reconcileVote(null, snap(11, 3)), 'ignore');
  });

  test('rolls back when the card did not close (someone joined meanwhile)', () => {
    assert.equal(reconcileVote(optimistic, snap(11, 2)), 'rollback');
  });

  test('rolls back on a request error (no snapshot)', () => {
    assert.equal(reconcileVote(optimistic, null), 'rollback');
  });

  test('ignores a stale or equal version', () => {
    assert.equal(reconcileVote(optimistic, snap(10, 2)), 'ignore');
    assert.equal(reconcileVote(optimistic, snap(9, 3)), 'ignore');
  });

  test('confirms when another close lands with the index one ahead (my vote included)', () => {
    assert.equal(reconcileVote(optimistic, snap(12, 3)), 'confirm');
  });

  test('rolls back when the index went backwards (undo) or jumped further', () => {
    assert.equal(reconcileVote(optimistic, snap(11, 1)), 'rollback');
    assert.equal(reconcileVote(optimistic, snap(11, 4)), 'rollback');
  });

  test('rolls back when voting was paused on the same card', () => {
    assert.equal(reconcileVote(optimistic, { version: 11, index: 2, phase: 'finished' }), 'rollback');
  });
});

describe('close announcements', () => {
  const closed = (version: number, gameId = 'valheim') => ({ version, index: 3, lastResult: { gameId, playedOut: true } });

  test('closeKey is tied to the room, the closed game and the closing version', () => {
    assert.equal(closeKey('ABC234', closed(11)), 'ABC234|valheim|11');
    assert.equal(closeKey('ABC234', { version: 4, lastResult: null }), null);
    assert.equal(closeKey('ABC234', null), null);
  });

  test('announces once per close: POST + SSE + resync of the same snapshot are repeats', () => {
    const once = createOnce();
    assert.equal(once(closeKey('ABC234', closed(11))), true);
    assert.equal(once(closeKey('ABC234', closed(11))), false);
    assert.equal(once(closeKey('ABC234', closed(11))), false);
    assert.equal(once(null), false);
  });

  test('the same card closed again after an undo, or in another room, is announced again', () => {
    const once = createOnce();
    assert.equal(once(closeKey('ABC234', closed(11))), true);
    assert.equal(once(closeKey('ABC234', closed(14))), true);
    assert.equal(once(closeKey('XYZ789', closed(11))), true);
  });

  test('memory is bounded: the oldest keys are forgotten first', () => {
    const once = createOnce(2);
    once('a'); once('b'); once('c');
    assert.equal(once('c'), false);
    assert.equal(once('a'), true);
  });
});
