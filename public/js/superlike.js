// Pure SuperLike bookkeeping (no DOM, covered by test/superlike.test.ts). A player has one per room;
// the server rejects a second one with 409 superlike_used, so the client only mirrors the rule to
// disable the button early. `votes` only holds closed cards, so those are the frozen superlikes.

/** True when the player's superlike sits on a closed card (it can no longer be taken back). */
export function superlikeFrozen(state, playerId) {
  return Object.values(state?.votes ?? {}).some((byPlayer) => byPlayer?.[playerId] === 'superlike');
}

/**
 * Whether the SuperLike button can be used on the open card.
 * pendingElsewhere: an optimistic advance is waiting for the server and its vote was a superlike.
 * A superlike already cast on the open card stays "available": the player may keep it or change it.
 */
export function superlikeAvailable({ state, playerId, myVote, pendingElsewhere = false }) {
  if (myVote === 'superlike') return true;
  return !pendingElsewhere && !superlikeFrozen(state, playerId);
}
