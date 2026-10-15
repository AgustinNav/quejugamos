import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileVote } from '../public/js/reconcile.js';

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
