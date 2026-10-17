// Platform filter rules shared by the lobby and the voting card. Pure: no DOM, tested in test/platforms.test.ts.

// Nothing preselected: with every platform on, a console group got PC-only-looking cards without noticing.
export const INITIAL_PLATFORMS = Object.freeze([]);

export function togglePlatform(selected, platform) {
  return selected.includes(platform) ? selected.filter((p) => p !== platform) : [...selected, platform];
}

/**
 * Card pills: the platforms the room chose first. Chosen ones skip `extra`, which the phone layout hides,
 * so a phone always shows why the game is in the deck. `roomPlatforms` null = old snapshot, all chosen.
 */
export function cardPlatforms(gamePlatforms, roomPlatforms) {
  const isChosen = (p) => !roomPlatforms || roomPlatforms.includes(p);
  return [...gamePlatforms.filter(isChosen), ...gamePlatforms.filter((p) => !isChosen(p))]
    .map((name) => ({ name, chosen: isChosen(name), className: isChosen(name) ? 'pill platform chosen' : 'pill extra' }));
}

/** PC requirements only matter when the group may play on PC. */
export const showsPcInfo = (roomPlatforms) => !roomPlatforms || roomPlatforms.includes('PC');
