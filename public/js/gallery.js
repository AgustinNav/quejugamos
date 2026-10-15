// Fullscreen media viewer (modal <dialog>). Nothing loads until it opens, and then only the
// selected item plus the thumbnails: friends are on mobile data, so no video preloading.
import { $ } from './dom.js';
import { attachMovie, playQuietly } from './player.js';
import { applyAudio, audioState, onAudioChange, setVolume, stepVolume, syncFromVideo, toggleMute } from './audio.js';

const SWIPE_MIN_PX = 50;
// Native video controls sit at the bottom: a horizontal drag there is scrubbing, not a swipe.
const VIDEO_CONTROLS_ZONE = 0.22;

let items = [];
let index = 0;
let player = null;
let onClose = null;
let unsubscribeAudio = null;

/** Gallery items from Steam details; tolerates old cache entries that only have `movie`. */
export function galleryItems(details) {
  if (!details) return [];
  const movies = Array.isArray(details.movies) ? details.movies : [details.movie];
  const thumbs = Array.isArray(details.screenshotThumbs) ? details.screenshotThumbs : [];
  const playable = movies.filter((m) => m && (m.hls || m.mp4));
  return [
    ...playable.map((movie, i) => ({ kind: 'movie', movie, thumb: movie.poster, label: `Trailer ${i + 1}${movie.name ? `: ${movie.name}` : ''}` })),
    ...(details.screenshots || []).map((src, i) => ({ kind: 'image', src, thumb: thumbs[i] || src, label: `Captura ${i + 1}` })),
  ];
}

let active = false;
let returnFocusTo = null;

// onClose({ resume }) runs once the gallery is closed; resume=false when the card changed under it.
export function openGallery({ title, items: list, start = 0, onClose: closeCallback }) {
  const dialog = $('gallery');
  if (active || !list.length) return;
  active = true;
  returnFocusTo = document.activeElement;
  items = list;
  onClose = closeCallback;
  $('galleryTitle').textContent = title;
  $('galleryThumbs').replaceChildren(...items.map(thumbButton));
  const single = items.length < 2;
  $('galleryPrev').hidden = single;
  $('galleryNext').hidden = single;
  dialog.showModal();
  document.body.classList.add('gallery-open');
  window.addEventListener('keydown', onKeydown, true);
  unsubscribeAudio = onAudioChange(renderGalleryAudio);
  select(start);
  $('galleryClose').focus();
}

// Teardown runs synchronously here: the dialog's `close` event is async and some embedded
// Chromium builds never fire it, which left the trailer playing behind a closed dialog.
export function closeGallery({ resume = true } = {}) {
  if (!active) return;
  active = false;
  teardown();
  const dialog = $('gallery');
  if (dialog.open) dialog.close();
  // Not every browser restores focus on dialog close; a hidden opener (card changed) is skipped.
  if (returnFocusTo?.isConnected && returnFocusTo.offsetParent !== null) returnFocusTo.focus();
  returnFocusTo = null;
  const callback = onClose;
  onClose = null;
  callback?.({ resume });
}

function teardown() {
  stopGalleryVideo();
  $('galleryImg').removeAttribute('src');
  $('galleryThumbs').replaceChildren();
  window.removeEventListener('keydown', onKeydown, true);
  unsubscribeAudio?.();
  unsubscribeAudio = null;
  document.body.classList.remove('gallery-open');
  items = [];
}

function thumbButton(item, i) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `gallery-thumb ${item.kind === 'movie' ? 'is-movie' : ''}`;
  button.dataset.index = String(i);
  button.setAttribute('aria-label', item.label);
  if (item.thumb) {
    const img = document.createElement('img');
    img.src = item.thumb;
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    button.append(img);
  }
  if (item.kind === 'movie') {
    const badge = document.createElement('span');
    badge.className = 'thumb-badge';
    badge.setAttribute('aria-hidden', 'true');
    badge.textContent = '▶';
    button.append(badge);
  }
  return button;
}

function stopGalleryVideo() {
  player?.destroy();
  player = null;
}

function select(i) {
  if (!items.length) return;
  index = (i + items.length) % items.length;
  const item = items[index];
  const video = $('galleryVideo');
  const img = $('galleryImg');
  stopGalleryVideo();
  video.hidden = item.kind !== 'movie';
  img.hidden = item.kind === 'movie';
  if (item.kind === 'movie') {
    img.removeAttribute('src');
    applyAudio(video);
    player = attachMovie(video, item.movie);
    playQuietly(video);
  } else {
    img.src = item.src;
    img.alt = item.label;
  }
  renderPosition(item);
  renderGalleryAudio(audioState());
}

// Our own slider, because native controls have no volume on phones (and iOS ignores it anyway).
function renderGalleryAudio({ muted, volume, adjustable }) {
  const slider = $('galleryVolume');
  const percent = Math.round(volume * 100);
  slider.hidden = items[index]?.kind !== 'movie' || !adjustable;
  slider.value = String(muted ? 0 : percent);
  slider.setAttribute('aria-valuetext', muted ? 'Silenciado' : `Volumen ${percent}%`);
  applyAudio($('galleryVideo'));
}

function renderPosition(item) {
  $('galleryCount').textContent = `${index + 1} / ${items.length} · ${item.kind === 'movie' ? 'Trailer' : 'Captura'}`;
  $('galleryThumbs').querySelectorAll('.gallery-thumb').forEach((button) => {
    const current = Number(button.dataset.index) === index;
    button.setAttribute('aria-current', String(current));
    if (current) button.scrollIntoView({ block: 'nearest', inline: 'center' });
  });
}

const step = (delta) => select(index + delta);

const KEYS = {
  ArrowLeft: () => step(-1),
  ArrowRight: () => step(1),
  Home: () => select(0),
  End: () => select(items.length - 1),
  Escape: () => closeGallery(),
  m: toggleMute,
  M: toggleMute,
  '+': () => stepVolume(1),
  '=': () => stepVolume(1),
  '-': () => stepVolume(-1),
  _: () => stepVolume(-1),
};

// Capture phase on window: runs before the card's shortcuts (vote, host actions) and stops them,
// whatever element has focus. Tab/Enter/Space keep their default behavior.
function onKeydown(e) {
  e.stopImmediatePropagation();
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target === $('galleryVolume') && e.key.startsWith('Arrow')) return; // arrows move the slider
  const action = KEYS[e.key];
  if (!action) return;
  e.preventDefault();
  action();
}

// Touch/pen only: on desktop the arrows, buttons and keys are enough, and a mouse drag would
// fight with selecting or scrubbing.
function bindSwipe(stage) {
  let start = null;
  stage.addEventListener('pointerdown', (e) => {
    start = null;
    if (e.pointerType === 'mouse' || e.target.closest('button')) return;
    if (e.target === $('galleryVideo') && inControlsZone(e)) return;
    start = { x: e.clientX, y: e.clientY };
  });
  stage.addEventListener('pointerup', (e) => {
    if (!start) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    start = null;
    if (Math.abs(dx) >= SWIPE_MIN_PX && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1);
  });
  stage.addEventListener('pointercancel', () => { start = null; });
}

function inControlsZone(e) {
  const rect = e.target.getBoundingClientRect();
  return e.clientY > rect.bottom - rect.height * VIDEO_CONTROLS_ZONE;
}

export function bindGallery() {
  const dialog = $('gallery');
  // Esc handled by the browser (close watcher) instead of our keydown: route it through closeGallery.
  dialog.addEventListener('cancel', (e) => { e.preventDefault(); closeGallery(); });
  dialog.addEventListener('close', () => closeGallery());
  $('galleryClose').addEventListener('click', () => closeGallery());
  $('galleryPrev').addEventListener('click', () => step(-1));
  $('galleryNext').addEventListener('click', () => step(1));
  $('galleryThumbs').addEventListener('click', (e) => {
    const button = e.target.closest('.gallery-thumb');
    if (button) select(Number(button.dataset.index));
  });
  $('galleryVideo').addEventListener('volumechange', (e) => syncFromVideo(e.target));
  $('galleryVolume').addEventListener('input', (e) => setVolume(Number(e.target.value) / 100));
  // Same as the card: iOS may pause a video unmuted mid-drag; the release is a gesture.
  $('galleryVolume').addEventListener('change', () => { if (player && $('galleryVideo').paused) playQuietly($('galleryVideo')); });
  bindSwipe($('galleryStage'));
}
