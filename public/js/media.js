// Media area of the card: trailer (see player.js) or screenshot, sound controls, and the
// button that opens the fullscreen gallery.
import { $, esc } from './dom.js';
import { getDetails } from './catalog.js';
import { attachMovie, playQuietly } from './player.js';
import { applyAudio, audioState, onAudioChange, setVolume, stepVolume, toggleMute as toggleAudioMute, volumeAdjustable } from './audio.js';
import { bindGallery, closeGallery, galleryItems, openGallery } from './gallery.js';

// The card strip stays short; the full set lives in the gallery.
const CARD_SHOTS = 4;

let player = null;
let currentGame = null;
let selectedIndex = 0; // gallery index of what the card shows, so the gallery opens there
let hasTrailer = false;

export function stopVideo() {
  player?.destroy();
  player = null;
}

function playTrailer(movie) {
  const video = $('video');
  stopVideo();
  video.hidden = false;
  $('mediaImg').hidden = true;
  applyAudio(video);
  player = attachMovie(video, movie);
  playQuietly(video);
}

function showImage(url) {
  stopVideo();
  $('video').hidden = true;
  const img = $('mediaImg');
  img.hidden = false;
  img.src = url;
}

function showPlaceholder(game) {
  stopVideo();
  $('video').hidden = true;
  $('mediaImg').hidden = true;
  $('media').insertAdjacentHTML('afterbegin', `<div class="placeholder">${esc(game.name)}</div>`);
}

// Buttons carry the gallery index of their item; the first trailer is the card's trailer.
function renderShots(items) {
  const trailerIndex = items.findIndex((item) => item.kind === 'movie');
  const shots = items.filter((item) => item.kind === 'image').slice(0, CARD_SHOTS);
  const buttons = [];
  if (trailerIndex !== -1) buttons.push(`<button type="button" class="trailer-thumb" data-index="${trailerIndex}" aria-label="Ver trailer">▶ Trailer</button>`);
  shots.forEach((item, i) => {
    buttons.push(`<button type="button" data-index="${items.indexOf(item)}" aria-label="Captura ${i + 1}"><img src="${esc(item.thumb)}" alt="" loading="lazy"></button>`);
  });
  $('shots').innerHTML = buttons.join('');
}

function markSelected() {
  $('shots').querySelectorAll('button').forEach((b) => b.classList.toggle('active', Number(b.dataset.index) === selectedIndex));
}

function renderControls(items) {
  hasTrailer = items.some((item) => item.kind === 'movie');
  $('muteBtn').hidden = !hasTrailer;
  $('volumeSlider').hidden = !hasTrailer || !volumeAdjustable();
  $('galleryBtn').hidden = items.length === 0;
}

function showItem(item, index) {
  selectedIndex = index;
  if (item.kind === 'movie') playTrailer(item.movie);
  else showImage(item.src);
  markSelected();
}

// force=true re-renders even for the same game (details arrived after the first paint).
export function renderMedia(game, { force = false } = {}) {
  if (!force && currentGame?.id === game.id) return;
  closeGallery({ resume: false }); // the card moved on: the gallery would show the wrong game
  currentGame = game;
  const d = getDetails(game.id) || {};
  const items = galleryItems(d);
  $('media').querySelector('.placeholder')?.remove();
  renderShots(items);
  renderControls(items);
  if (items.length) return showItem(items[0], 0);
  selectedIndex = 0;
  if (d.header) return showImage(d.header);
  showPlaceholder(game);
}

export function resetMedia() {
  closeGallery({ resume: false });
  currentGame = null;
  stopVideo();
}

export const toggleMute = toggleAudioMute;
export const volumeUp = () => stepVolume(1);
export const volumeDown = () => stepVolume(-1);

function renderAudio({ muted, volume, adjustable }) {
  const percent = Math.round(volume * 100);
  const button = $('muteBtn');
  button.textContent = muted ? '🔇' : volume < 0.5 ? '🔉' : '🔊';
  button.setAttribute('aria-label', muted ? 'Activar sonido del trailer' : 'Silenciar trailer');
  const slider = $('volumeSlider');
  slider.value = String(muted ? 0 : percent);
  slider.style.setProperty('--fill', `${muted ? 0 : percent}%`); // filled track (styles.css)
  slider.setAttribute('aria-valuetext', muted ? 'Silenciado' : `Volumen ${percent}%`);
  slider.hidden = !hasTrailer || !adjustable; // Web Audio can fail late (iOS): then mute-only
  applyAudio($('video'));
}

export function openCardGallery() {
  const items = galleryItems(currentGame && getDetails(currentGame.id));
  if (!currentGame || !items.length) return;
  const video = $('video');
  const wasPlaying = Boolean(player) && !video.paused;
  video.pause(); // one sound source at a time
  openGallery({
    title: currentGame.name,
    items,
    start: Math.min(selectedIndex, items.length - 1),
    onClose: ({ resume }) => { if (resume && wasPlaying && player) playQuietly(video); },
  });
}

export function bindMedia() {
  $('shots').addEventListener('click', (e) => {
    const button = e.target.closest('button[data-index]');
    const items = galleryItems(currentGame && getDetails(currentGame.id));
    const index = Number(button?.dataset.index);
    if (button && items[index]) showItem(items[index], index);
  });
  $('muteBtn').addEventListener('click', toggleAudioMute);
  $('volumeSlider').addEventListener('input', (e) => setVolume(Number(e.target.value) / 100));
  // iOS may pause a video unmuted mid-drag (not a "gesture" yet); the release is one, so resume there.
  $('volumeSlider').addEventListener('change', () => { if (player && $('video').paused) playQuietly($('video')); });
  $('galleryBtn').addEventListener('click', openCardGallery);
  // Dragging the slider must not drag (and vote) the card underneath.
  $('mediaActions').addEventListener('pointerdown', (e) => e.stopPropagation());
  onAudioChange(renderAudio);
  renderAudio(audioState());
  bindGallery();
}
