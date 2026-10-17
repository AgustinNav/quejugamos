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

/**
 * Identity of one card close for its announcement (toast, match overlay): the room, the closed game
 * and the version of the snapshot that closed it. A re-render, a repeated snapshot (POST + SSE),
 * a reconnect or a resync never produce a new key; closing the same card again after an undo does.
 */
export function closeKey(roomCode, snapshot) {
  const result = snapshot?.lastResult;
  if (!result) return null;
  return `${roomCode}|${result.gameId}|${snapshot.version}`;
}

/** Returns once(key): true the first time a key is seen, false for repeats and null keys. */
export function createOnce(capacity = 32) {
  const seen = new Set();
  return (key) => {
    if (key === null || key === undefined || seen.has(key)) return false;
    seen.add(key);
    if (seen.size > capacity) seen.delete(seen.values().next().value);
    return true;
  };
}

/**
 * Applies an SSE `voters` event ({ version, currentVoters }) to the current server state.
 * The event carries only what a vote on the open card changes, so it is valid solely on top of
 * the state one version before it:
 *  - null      stale (version ≤ current) or no state yet: nothing to do.
 *  - 'resync'  a gap or a malformed event: the caller refetches the full snapshot.
 *  - otherwise the next state, to go through the same path as a full snapshot.
 */
export function applyVotersEvent(state, event) {
  if (!state || !Number.isInteger(event?.version) || event.version <= state.version) return null;
  if (event.version !== state.version + 1 || !Array.isArray(event.currentVoters)) return 'resync';
  return { ...state, currentVoters: event.currentVoters, version: event.version };
}
