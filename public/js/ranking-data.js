// Pure helpers over a room snapshot for the results screens: no DOM, so node:test covers them
// (test/ranking-data.test.ts). Counts always come from the frozen per-card `results`.

/** The host paused voting before the deck ran out: deck[index] was discarded, not ranked. */
export const finishedEarly = (state) => state.phase === 'finished' && state.index < state.deck.length;

/** Results of the cards that closed, in deck order. */
export function closedResults(state) {
  return state.deck.slice(0, state.index).map((id) => state.results[id]).filter(Boolean);
}

/** Cards where most of the votes cast were "already played": listed apart, never ranked or a match. */
export const playedOutResults = (state) => closedResults(state).filter((r) => r.playedOut);

export const rankedResults = (state) => closedResults(state).filter((r) => !r.playedOut);

/** Games nobody got to vote (only after an early finish): the discarded open card and everything after it. */
export const unvotedGameIds = (state) => (finishedEarly(state) ? state.deck.slice(state.index) : []);

/** Cards still to close while voting (the open one included). */
export const remainingCount = (state) => Math.max(0, state.deck.length - state.index);

/**
 * Ids worth fetching details for: not loaded and never tried. Re-rendering after a fetch must not ask
 * for the same ids again: a game with no Steam data resolves in the same microtask and stays without
 * details, so a render that refetches it loops forever and freezes the page. Marks the ids as tried.
 */
export function idsToFetch(ids, hasDetails, tried) {
  const fresh = ids.filter((id) => !hasDetails(id) && !tried.has(id));
  fresh.forEach((id) => tried.add(id));
  return fresh;
}
