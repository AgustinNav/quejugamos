// Pure trailer-volume rules (no DOM, no storage): audio.js wires them to the page and
// test/volume.test.ts pins them down. State is { muted, volume } with volume in [0, 1]: the
// slider position. What reaches the speakers is outputGain(volume), never the position itself.

// "All trailers at full volume kills you": unmuting never jumps above this unless the user chose so.
export const UNMUTE_VOLUME = 0.5;
export const VOLUME_STEP = 0.1;

export function clampVolume(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, Math.round(value * 100) / 100));
}

// Loudness is perceived roughly logarithmically: a linear gain at 10 % is only -20 dB, which still
// sounds loud with Steam trailers. Squaring the position gives 50 % → 0.25 (-12 dB), 10 % → 0.01
// (-40 dB), 5 % → -52 dB, so the low end of the slider is actually quiet.
export function outputGain(volume) {
  const level = clampVolume(volume);
  return Math.round(level * level * 10000) / 10000;
}

// Inverse of outputGain, for a level read back from an element (native controls).
export function levelFromGain(gain) {
  if (!Number.isFinite(gain) || gain <= 0) return 0;
  return clampVolume(Math.sqrt(Math.min(1, gain)));
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
// The element holds the gain: when it is (about) the gain we set, keep our level, so the
// volumechange caused by our own write never nudges the slider through rounding.
export function syncedFromElement(state, { muted, volume }, volumeReadable) {
  const ours = Math.abs(volume - outputGain(state.volume)) < 0.0005;
  const level = volumeReadable && !ours ? levelFromGain(volume) : state.volume;
  return muted ? { muted: true, volume: level } : { muted: false, volume: unmuteVolume(level) };
}
