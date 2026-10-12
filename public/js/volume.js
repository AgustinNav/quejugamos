// Pure trailer-volume rules (no DOM, no storage): audio.js wires them to the page and
// test/volume.test.ts pins them down. State is { muted, volume } with volume in [0, 1].

// "All trailers at full volume kills you": unmuting never jumps above this unless the user chose so.
export const UNMUTE_VOLUME = 0.5;
export const VOLUME_STEP = 0.1;

export function clampVolume(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, Math.round(value * 100) / 100));
}

// The stored level is the user's own choice; null when they never moved it (or storage is junk).
export function parseStoredVolume(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? clampVolume(value) : null;
}

// Every page load starts muted (autoplay policy, and nobody wants a surprise); the level survives.
export function initialAudioState(storedRaw) {
  return { muted: true, volume: parseStoredVolume(storedRaw) ?? UNMUTE_VOLUME };
}

// Unmuting at 0 would look broken, so a zero level comes back at the default.
export const unmuteVolume = (volume) => (volume > 0 ? volume : UNMUTE_VOLUME);

export function toggledMute(state) {
  if (state.muted) return { muted: false, volume: unmuteVolume(state.volume) };
  return { muted: true, volume: state.volume };
}

export function withVolume(state, value) {
  const volume = clampVolume(value);
  return { muted: volume === 0, volume };
}

// direction: +1 / -1. Turning it up while muted means "I want sound": unmute at the remembered level.
export function steppedVolume(state, direction) {
  if (state.muted) return direction > 0 ? toggledMute(state) : state;
  const volume = clampVolume(state.volume + direction * VOLUME_STEP);
  return { muted: volume === 0, volume };
}

// Native <video controls> (gallery) changed the element. Where the browser ignores video.volume
// (iOS) only the mute bit is meaningful; an unmute that lands at 0 gets the default level.
export function syncedFromElement(state, { muted, volume }, volumeReadable) {
  const level = volumeReadable ? clampVolume(volume) : state.volume;
  return muted ? { muted: true, volume: level } : { muted: false, volume: unmuteVolume(level) };
}
