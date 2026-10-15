// Pure decision for the optimistic "last voter" advance (no DOM, covered by test/reconcile.test.ts).
// The UI shows deck[toIndex] before the server confirms; the server snapshot stays the source of truth.

/**
 * optimistic: { fromIndex, toIndex, baseVersion } captured when the own vote was cast, or null.
 * snapshot: the incoming server state (POST response or SSE), or null when the vote request failed.
 *  - 'confirm'  the card closed: the screen already shows the right card, only sync the data.
 *  - 'rollback' the card did not close (someone joined, vote rejected, undo/finish, request error):
 *               bring the previous card back and apply the snapshot.
 *  - 'ignore'   nothing to reconcile, or a snapshot not newer than the state the vote was cast on.
 */
export function reconcileVote(optimistic, snapshot) {
  if (!optimistic) return 'ignore';
  if (!snapshot) return 'rollback';
  if (snapshot.version <= optimistic.baseVersion) return 'ignore';
  return snapshot.index === optimistic.toIndex ? 'confirm' : 'rollback';
}
