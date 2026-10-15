// "Ranking parcial": modal sheet with the ranking of the cards closed so far, openable by anyone
// while voting. It only reads the frozen `results` (via results.js), never recomputes from `votes`.
// The open card stays as is underneath: its trailer is paused while the sheet is open and resumed after.
import { $ } from './dom.js';
import { playQuietly } from './player.js';
import { renderPlayedGroup, renderRanking } from './views/results.js';
import { remainingCount } from './ranking-data.js';

let open = false;
let resumeOnClose = false;
let returnFocusTo = null;

function paint(state) {
  const closed = state.index;
  $('rankingSheetNote').textContent = closed
    ? `${closed} de ${state.deck.length} juegos cerrados. La tarjeta actual todavía no cuenta. Faltan ${remainingCount(state)}.`
    : '';
  renderRanking(state, $('partialRanking'), 'Todavía no se cerró ningún juego: votá el primero y volvé.');
  renderPlayedGroup(state, $('partialPlayedGroup'), $('partialPlayedList'));
}

// A new card can start its trailer while the sheet is open (another player closed the card).
function holdVideo(e) {
  resumeOnClose = true;
  e.target.pause();
}

export function openRankingSheet(state) {
  if (open || state?.phase !== 'voting') return;
  open = true;
  returnFocusTo = document.activeElement;
  const video = $('video');
  resumeOnClose = !video.paused;
  video.pause();
  video.addEventListener('play', holdVideo);
  paint(state);
  $('rankingSheet').showModal();
  window.addEventListener('keydown', onKeydown, true);
  $('rankingSheetClose').focus();
}

// resume=false when the room left voting (the card is gone, nothing to resume).
export function closeRankingSheet({ resume = true } = {}) {
  if (!open) return;
  open = false;
  window.removeEventListener('keydown', onKeydown, true);
  const video = $('video');
  video.removeEventListener('play', holdVideo);
  const dialog = $('rankingSheet');
  if (dialog.open) dialog.close();
  if (resume && resumeOnClose && video.currentSrc && !video.hidden) playQuietly(video);
  if (returnFocusTo?.isConnected && returnFocusTo.offsetParent !== null) returnFocusTo.focus();
  returnFocusTo = null;
}

/** Called on every render: repaints while open, closes once the room is no longer voting. */
export function syncRankingSheet(state) {
  if (!open) return;
  if (state?.phase !== 'voting') return closeRankingSheet({ resume: false });
  paint(state);
}

// Capture phase on window, like the gallery: vote/host shortcuts must not fire behind the sheet.
// Tab/Enter/Space keep their default behavior.
function onKeydown(e) {
  e.stopImmediatePropagation();
  if (e.key !== 'Escape') return;
  e.preventDefault();
  closeRankingSheet();
}

export function bindRankingSheet(getState) {
  const dialog = $('rankingSheet');
  $('partialRankingBtn').addEventListener('click', () => openRankingSheet(getState()));
  $('rankingSheetClose').addEventListener('click', () => closeRankingSheet());
  dialog.addEventListener('cancel', (e) => { e.preventDefault(); closeRankingSheet(); });
  dialog.addEventListener('close', () => closeRankingSheet());
  // A click on the backdrop lands on the <dialog> itself.
  dialog.addEventListener('click', (e) => { if (e.target === dialog) closeRankingSheet(); });
}
