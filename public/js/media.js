// Trailer (mp4 or HLS via hls.js) / screenshot area of the card.
import { $, esc } from './dom.js';
import { getDetails } from './catalog.js';

let hls = null;
let muted = true;
let currentGameId = null;

export function stopVideo() {
  if (hls) { hls.destroy(); hls = null; }
  const video = $('video');
  video.pause();
  video.removeAttribute('src');
  video.load();
}

function playTrailer(movie) {
  const video = $('video');
  stopVideo();
  video.hidden = false;
  $('mediaImg').hidden = true;
  video.poster = movie.poster || '';
  video.muted = muted;
  if (movie.mp4) {
    video.src = movie.mp4;
  } else if (window.Hls?.isSupported()) {
    hls = new window.Hls({ capLevelToPlayerSize: true });
    hls.loadSource(movie.hls);
    hls.attachMedia(video);
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = movie.hls;
  }
  video.play().catch(() => { /* autoplay can be blocked until the first user gesture */ });
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

function renderShots(d) {
  const shots = [];
  if (d.movie) shots.push('<button type="button" class="trailer-thumb active" data-trailer aria-label="Ver trailer">▶ Trailer</button>');
  (d.screenshots || []).forEach((src, i) => {
    const active = !d.movie && i === 0 ? 'active' : '';
    shots.push(`<button type="button" data-shot="${esc(src)}" class="${active}" aria-label="Captura ${i + 1}"><img src="${esc(src)}" alt="" loading="lazy"></button>`);
  });
  $('shots').innerHTML = shots.join('');
  $('muteBtn').hidden = !d.movie;
}

// force=true re-renders even for the same game (details arrived after the first paint).
export function renderMedia(game, { force = false } = {}) {
  if (!force && currentGameId === game.id) return;
  currentGameId = game.id;
  const d = getDetails(game.id) || {};
  $('media').querySelector('.placeholder')?.remove();
  renderShots(d);
  if (d.movie) return playTrailer(d.movie);
  if (d.screenshots?.length || d.header) return showImage(d.screenshots?.[0] || d.header);
  showPlaceholder(game);
}

export function resetMedia() {
  currentGameId = null;
  stopVideo();
}

export function toggleMute() {
  muted = !muted;
  $('video').muted = muted;
  $('muteBtn').textContent = muted ? '🔇' : '🔊';
  $('muteBtn').setAttribute('aria-label', muted ? 'Activar sonido del trailer' : 'Silenciar trailer');
}

export function bindMedia() {
  $('shots').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    $('shots').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
    const d = getDetails(currentGameId);
    if (btn.dataset.trailer !== undefined && d?.movie) playTrailer(d.movie);
    else if (btn.dataset.shot) showImage(btn.dataset.shot);
  });
  $('muteBtn').addEventListener('click', toggleMute);
}
