// Pure swipe math: no DOM, so node:test covers it (test/gesture.test.ts). swipe.js feeds it
// pointer samples and paints whatever it returns.

/** Movement before deciding between a horizontal swipe and a vertical page scroll. */
export const AXIS_LOCK_PX = 8;
/** A release faster than this (px/ms) is a flick: it votes even below the distance threshold. */
export const FLICK_VELOCITY = 0.5;
/** A flick still needs some travel, so a twitch at the start of a scroll never votes. */
export const FLICK_MIN_DX = 24;
/** Only the last stretch of the gesture counts for the release velocity. */
export const VELOCITY_WINDOW_MS = 100;

const MAX_ROTATION_DEG = 18;
const VERTICAL_FOLLOW = 0.35;
const UNDER_SCALE = 0.95;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** 'x' (swipe), 'y' (let the page scroll) or null while the finger is still inside the slop. */
export function lockAxis(dx, dy, lockPx = AXIS_LOCK_PX) {
  if (Math.hypot(dx, dy) < lockPx) return null;
  return Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
}

/** Distance that votes on release: ~30 % of the card, within a range that works on phone and TV. */
export function swipeThreshold(cardWidth) {
  return clamp(cardWidth * 0.3, 80, 120);
}

/** 0..1, how far the drag is towards a vote. */
export function dragProgress(dx, threshold) {
  return clamp(Math.abs(dx) / threshold, 0, 1);
}

/** Everything a drag frame paints: card offset/rotation, stamp opacity and the card underneath. */
export function dragFrame(dx, dy, cardWidth) {
  const progress = dragProgress(dx, swipeThreshold(cardWidth));
  return {
    x: dx,
    y: dy * VERTICAL_FOLLOW,
    rotation: clamp((dx / Math.max(cardWidth, 1)) * MAX_ROTATION_DEG, -MAX_ROTATION_DEG, MAX_ROTATION_DEG),
    likeOpacity: dx > 0 ? progress : 0,
    nopeOpacity: dx < 0 ? progress : 0,
    underScale: UNDER_SCALE + (1 - UNDER_SCALE) * progress,
  };
}

export const UNDER_SCALE_REST = UNDER_SCALE;

/** Horizontal velocity in px/ms over the last VELOCITY_WINDOW_MS of samples ({ t, x }, oldest first). */
export function velocityX(samples, windowMs = VELOCITY_WINDOW_MS) {
  if (samples.length < 2) return 0;
  const last = samples[samples.length - 1];
  const first = samples.find((s) => last.t - s.t <= windowMs) ?? samples[0];
  const dt = last.t - first.t;
  return dt > 0 ? (last.x - first.x) / dt : 0;
}

/**
 * 'like' | 'nope' | null on release. A flick decides by its direction; a flick back towards the
 * centre cancels even past the threshold (the user is throwing the card back).
 */
export function releaseDecision({ dx, vx, threshold }) {
  const flick = Math.abs(vx) >= FLICK_VELOCITY;
  if (flick && Math.sign(vx) !== Math.sign(dx)) return null;
  if (flick && Math.abs(dx) >= FLICK_MIN_DX) return dx > 0 ? 'like' : 'nope';
  if (Math.abs(dx) >= threshold) return dx > 0 ? 'like' : 'nope';
  return null;
}

/**
 * Where a card thrown from `from` ends (fully off screen) and how long it takes. The duration keeps
 * roughly the release speed, so the card never slows down abruptly when the finger lets go.
 */
export function flyOutTarget({ from, direction, viewportWidth, cardWidth, vx = 0 }) {
  const sign = direction === 'right' ? 1 : -1;
  const x = sign * (viewportWidth + cardWidth);
  const distance = Math.abs(x - from.x);
  const speed = Math.max(Math.abs(vx) * 1.5, 1.6); // px/ms; the ease-out starts ~1.5x faster than average
  return {
    x,
    y: from.y,
    rotation: sign * MAX_ROTATION_DEG,
    durationMs: Math.round(clamp(distance / speed, 220, 340)),
  };
}

/**
 * True when this player's vote is the last one missing, so the server will close the card.
 * currentVoters says who voted, not what, so players who voted "played" count like any other.
 */
export function closesCard(state, myId) {
  const voters = new Set(state.currentVoters);
  if (voters.has(myId)) return false; // changing a vote never completes the round
  return state.players.every((p) => p.id === myId || voters.has(p.id));
}
