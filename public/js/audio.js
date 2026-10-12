// Trailer sound: one muted flag + one volume level shared by the card and the gallery.
// Muted on every load (browsers block unmuted autoplay); the volume level is remembered.

const STORAGE_KEY = 'quejugamos:volume';
const DEFAULT_VOLUME = 0.7;
const STEP = 0.1;

// iOS Safari ignores video.volume (read-only, always 1): there, only mute works.
export const volumeSupported = detectVolumeSupport();

const state = { muted: true, volume: readStoredVolume() };
const listeners = new Set();

function detectVolumeSupport() {
  try {
    const probe = document.createElement('video');
    probe.volume = 0.5;
    return Math.abs(probe.volume - 0.5) < 0.01;
  } catch {
    return false;
  }
}

function clampVolume(value) {
  return Math.min(1, Math.max(0, Math.round(value * 100) / 100));
}

function readStoredVolume() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const value = Number(raw);
    return raw !== null && Number.isFinite(value) ? clampVolume(value) : DEFAULT_VOLUME;
  } catch {
    return DEFAULT_VOLUME; // storage blocked (private mode, sandbox): just don't remember
  }
}

function storeVolume(value) {
  try {
    localStorage.setItem(STORAGE_KEY, String(value));
  } catch { /* storage blocked: the level lasts for this page only */ }
}

function update(next) {
  if (next.muted === state.muted && next.volume === state.volume) return;
  if (next.volume !== state.volume) storeVolume(next.volume);
  Object.assign(state, next);
  listeners.forEach((listener) => listener(audioState()));
}

export const audioState = () => ({ ...state });

export function onAudioChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function applyAudio(video) {
  video.muted = state.muted;
  if (volumeSupported) video.volume = state.volume;
}

export function toggleMute() {
  // Unmuting at volume 0 would look broken: bring the level back.
  if (state.muted && state.volume === 0) return update({ muted: false, volume: DEFAULT_VOLUME });
  update({ muted: !state.muted, volume: state.volume });
}

export function setVolume(value) {
  const volume = clampVolume(value);
  update({ volume, muted: volume === 0 });
}

// direction: +1 / -1. Turning it up while muted means "I want sound": unmute at the remembered level.
export function stepVolume(direction) {
  if (!volumeSupported) return;
  if (state.muted && direction > 0) return update({ muted: false, volume: state.volume || STEP });
  const volume = clampVolume(state.volume + direction * STEP);
  update({ volume, muted: state.muted || volume === 0 });
}

// The gallery uses native controls: whatever the viewer does there becomes the shared setting.
export function syncFromVideo(video) {
  update({ muted: video.muted, volume: volumeSupported ? clampVolume(video.volume) : state.volume });
}
