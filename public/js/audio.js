// Trailer sound: one muted flag + one volume level shared by the card and the gallery.
// Muted on every load (browsers block unmuted autoplay); the level the user picks is remembered.
// The rules live in volume.js; this module applies them to the <video> elements.
import { initialAudioState, steppedVolume, syncedFromElement, toggledMute, withVolume } from './volume.js';

// v2: earlier builds could store their old 0.7 default, which is exactly the "too loud" level.
const STORAGE_KEY = 'quejugamos:volume:v2';

// iOS Safari ignores video.volume (read-only, always 1). There the level goes through Web Audio:
// <video> → MediaElementSource → GainNode → speakers, with the gain as the level.
export const volumeSupported = detectVolumeSupport();
const AudioContextClass = window.AudioContext || window.webkitAudioContext;
// Web Audio only hears a MediaElementSource whose media is CORS-clean. hls.js (MSE, or iOS 17.1+
// ManagedMediaSource) and mp4 with crossOrigin are; Safari's native HLS player is not reliably
// routed (WebKit has output silence for it). So devices without hls.js support (iPhone < iOS 17.1)
// get mute-only: decided per device, never per trailer, so a routed element never goes silent.
const webAudioCandidate = !volumeSupported && Boolean(AudioContextClass) && Boolean(window.Hls?.isSupported?.());
let webAudioFailed = false;
let audioContext = null;
// <video> → GainNode. Only #video and #galleryVideo are ever routed; both are static elements
// reused for every trailer (player.js swaps their source), so the graph is built once per element
// and never torn down: disconnecting it would leave the element silent until a reload.
const routes = new WeakMap();

const state = initialAudioState(readStoredVolume());
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

const usesWebAudio = () => webAudioCandidate && !webAudioFailed;

/** True when this device can set a level (slider/+/−); false means mute-only. */
export const volumeAdjustable = () => volumeSupported || usesWebAudio();

function readStoredVolume() {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null; // storage blocked (private mode, sandbox): just don't remember
  }
}

function storeVolume(value) {
  try {
    localStorage.setItem(STORAGE_KEY, String(value));
  } catch { /* storage blocked: the level lasts for this page only */ }
}

function emit() {
  listeners.forEach((listener) => listener(audioState()));
}

function update(next) {
  if (next.muted === state.muted && next.volume === state.volume) return;
  if (next.volume !== state.volume) storeVolume(next.volume);
  Object.assign(state, next);
  emit();
}

export const audioState = () => ({ ...state, adjustable: volumeAdjustable() });

export function onAudioChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Never leave the user with silence they can't fix: on any Web Audio error, fall back to plain
// mute/unmute at device volume and hide the slider.
function disableWebAudio(err) {
  if (webAudioFailed) return;
  webAudioFailed = true;
  console.warn('Web Audio volume unavailable, falling back to mute only', err);
  emit();
}

// iOS only lets an AudioContext start (or come back after a call / screen lock) inside a user
// gesture, so every tap, click or key tries. Cheap once it is running.
function resumeAudioContext() {
  if (!usesWebAudio()) return;
  try {
    audioContext ||= new AudioContextClass();
    // A refused resume (no gesture yet) is retried on the next touch: not a reason to give up.
    if (audioContext.state !== 'running') audioContext.resume().catch(() => {});
  } catch (err) {
    disableWebAudio(err);
  }
}

function setPlaybackSession() {
  // Web Audio follows the ringer switch on iOS; a trailer the user unmuted should play like
  // a video does. Safari 17+ (Audio Session API); elsewhere this property doesn't exist.
  try {
    if (navigator.audioSession) navigator.audioSession.type = 'playback';
  } catch { /* not supported: the ringer switch may mute the trailer, as with any web audio */ }
}

// Routing is permanent (a MediaElementSource can be created once per element). It happens on the
// first unmute, which is a tap/click/key: the capture listener below has just created or resumed
// the context in that same gesture, so the sound starts at the chosen level, never at full blast.
function gainFor(video) {
  if (routes.has(video)) return routes.get(video);
  if (!usesWebAudio()) return null;
  resumeAudioContext();
  if (!audioContext) return null;
  try {
    const source = audioContext.createMediaElementSource(video);
    const gain = audioContext.createGain();
    source.connect(gain).connect(audioContext.destination);
    routes.set(video, gain);
    setPlaybackSession();
    return gain;
  } catch (err) {
    disableWebAudio(err);
    return null;
  }
}

/** Call before the element gets a source: Web Audio needs CORS-clean media (Steam's CDN sends ACAO: *). */
export function prepareVideo(video) {
  if (usesWebAudio()) video.crossOrigin = 'anonymous';
}

// The element's `muted` stays the mute switch everywhere (iOS needs it for autoplay); on the
// Web Audio path the gain carries the level and is also 0 while muted, so both agree.
// A routed element keeps its gain even if Web Audio later failed: best effort beats silence.
export function applyAudio(video) {
  if (volumeSupported) video.volume = state.volume;
  else {
    const gain = state.muted ? routes.get(video) : gainFor(video);
    if (gain) gain.gain.value = state.muted ? 0 : state.volume;
  }
  video.muted = state.muted; // after the gain: unmuting never plays a frame at full level
}

export function toggleMute() {
  update(toggledMute(state));
}

export function setVolume(value) {
  update(withVolume(state, value));
}

export function stepVolume(direction) {
  if (!volumeAdjustable() && !(state.muted && direction > 0)) return;
  update(steppedVolume(state, direction));
}

// The gallery uses native controls: whatever the viewer does there becomes the shared setting.
export function syncFromVideo(video) {
  update(syncedFromElement(state, { muted: video.muted, volume: video.volume }, volumeSupported));
}

// Capture phase on window: runs before any handler (mute button, slider, keys) so the context is
// already running when that handler unmutes. Kept for the page's life to recover from iOS
// interruptions (calls, lock screen) on the next touch.
if (webAudioCandidate) {
  for (const type of ['touchend', 'click', 'keydown']) {
    window.addEventListener(type, resumeAudioContext, { capture: true, passive: true });
  }
}
