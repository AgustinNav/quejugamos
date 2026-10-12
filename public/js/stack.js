// The card underneath the open one (Tinder-style stack): the next game's cover and name, already
// painted, so the top card leaving never shows an empty frame. It only previews; it never votes.
import { $ } from './dom.js';
import { getDetails, getGame } from './catalog.js';
import { galleryItems } from './gallery.js';

let shownId = null;
let pendingId = null;
let frozen = false;

/** The image the card shows first for this game (same order as media.js renderMedia). */
export function coverUrl(gameId) {
  const d = getDetails(gameId);
  if (!d) return null;
  const first = galleryItems(d)[0];
  if (first?.kind === 'movie') return first.movie.poster || d.header || null;
  return first?.src || d.header || null;
}

/** Shows `gameId` (or nothing) underneath. While frozen, the change waits for unfreezeUnder(). */
export function renderUnder(gameId, { force = false } = {}) {
  pendingId = gameId ?? null;
  if (frozen || (!force && pendingId === shownId)) return;
  paint(pendingId);
}

// Freezing keeps the preview that matches the card about to be revealed on top of it.
export function freezeUnder() {
  frozen = true;
}

export function unfreezeUnder() {
  frozen = false;
  if (pendingId !== shownId) paint(pendingId);
}

function paint(gameId) {
  shownId = gameId;
  const under = $('cardUnder');
  under.hidden = !gameId;
  if (!gameId) return;
  const url = coverUrl(gameId);
  const img = $('underImg');
  img.hidden = !url;
  if (url) img.src = url;
  else img.removeAttribute('src');
  $('underName').textContent = getGame(gameId)?.name ?? gameId;
}

/** Resolves once the under card's cover is decoded (or after maxMs), so the swap is invisible. */
export function underReady(maxMs = 250) {
  const img = $('underImg');
  if (img.hidden || !img.src || typeof img.decode !== 'function') return Promise.resolve();
  const timeout = new Promise((resolve) => setTimeout(resolve, maxMs));
  return Promise.race([img.decode().catch(() => {}), timeout]);
}
