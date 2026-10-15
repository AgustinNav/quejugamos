// Ranking of the closed cards sorted by likes, matches (everyone liked it) highlighted. Cards where
// most voters had already played the game go in their own group; after a pause, the games nobody
// got to vote are listed too.
import { $, esc, showScreen } from '../dom.js';
import { getGame, getDetails, loadMany, priceInfo, priceUsd, storeUrl } from '../catalog.js';
import { finishedEarly, idsToFetch, playedOutResults, rankedResults, unvotedGameIds } from '../ranking-data.js';

const THUMBS_TO_FETCH = 10;
const UNVOTED_VISIBLE = 12;
let renderToken = 0;
let unvotedToken = 0;
const unvotedTried = new Set(); // ids already fetched once for the "Sin votar" list
let unvotedExpanded = false;

const playedLabel = (n) => `${n} lo jugaron`;

// Counts come only from the server's frozen per-card result (never recomputed from `votes`, see
// CLAUDE.md Mistakes Log); `votes` only supplies the names of likers still in the room.
function tally(state, result) {
  const votes = state.votes[result.gameId] || {};
  const likers = state.players.filter((p) => votes[p.id] === 'like').map((p) => p.name);
  return { likers, ...result };
}

/** Paints the "Ya jugados" group (cards most voters had already played) into the given group/list. */
export function renderPlayedGroup(state, group, list) {
  const rows = playedOutResults(state).map((r) => [getGame(r.gameId), r]).filter(([game]) => game);
  group.hidden = rows.length === 0;
  list.innerHTML = rows
    .map(([game, r]) => `<li><span aria-hidden="true">✅</span> ${esc(game.name)} <span class="muted">· ${playedLabel(r.played)}</span></li>`)
    .join('');
}

function rankRows(state) {
  return rankedResults(state)
    .filter((r) => getGame(r.gameId))
    .map((r) => ({ game: getGame(r.gameId), ...tally(state, r) }))
    .sort((a, b) => b.likes - a.likes || a.nopes - b.nopes || (priceUsd(a.game) ?? 99) - (priceUsd(b.game) ?? 99));
}

export function renderResults(state, note = '') {
  const early = finishedEarly(state);
  if (!early) unvotedExpanded = false;
  const progress = early ? `Votación en pausa: ${state.index} de ${state.deck.length} juegos votados.` : '';
  $('resultsTitle').textContent = early ? '🏆 Ranking preliminar' : '🏆 Ranking final';
  $('resultsNote').textContent = [note, progress].filter(Boolean).join(' ');
  $('resumeVotingBtn').hidden = !early; // CSS also hides it for anyone but the host
  renderRanking(state, $('ranking'));
  renderPlayedGroup(state, $('playedGroup'), $('playedList'));
  renderUnvoted(state);
  showScreen('resultsScreen');
}

function unvotedItem(game) {
  const d = getDetails(game.id) || {};
  const thumb = d.header
    ? `<img src="${esc(d.header)}" alt="" loading="lazy" decoding="async">`
    : `<div class="thumb-ph">${esc(game.name)}</div>`;
  return `<li>${thumb}<span class="r-name">${esc(game.name)}</span></li>`;
}

// "Sin votar": only after a pause. Thumbnails (Steam header images) load for the visible part only.
function renderUnvoted(state) {
  const games = unvotedGameIds(state).map((id) => getGame(id)).filter(Boolean);
  $('unvotedGroup').hidden = games.length === 0;
  if (!games.length) return;
  const shown = unvotedExpanded ? games : games.slice(0, UNVOTED_VISIBLE);
  const hidden = games.length - shown.length;
  $('unvotedTitle').textContent = `Sin votar (${games.length})`;
  $('unvotedList').innerHTML = shown.map(unvotedItem).join('');
  $('unvotedMoreBtn').hidden = hidden === 0;
  $('unvotedMoreBtn').textContent = `+${hidden} más`;
  const token = ++unvotedToken;
  const missing = idsToFetch(shown.map((g) => g.id), (id) => Boolean(getDetails(id)), unvotedTried);
  if (missing.length) loadMany(missing).then(() => { if (token === unvotedToken) renderUnvoted(state); });
}

export function bindUnvoted(getState) {
  $('unvotedMoreBtn').addEventListener('click', () => {
    unvotedExpanded = true;
    const state = getState();
    if (state) renderUnvoted(state);
  });
}

/** Paints the ranking of closed cards into `list` (also used by the partial-ranking sheet). */
export function renderRanking(state, list, emptyText = 'No se llegó a votar ningún juego.') {
  const rows = rankRows(state);
  paint(rows, list, emptyText);
  // Thumbnails/prices for the top of the ranking; repaint once they arrive.
  const token = ++renderToken;
  const missing = rows.slice(0, THUMBS_TO_FETCH).map((r) => r.game.id).filter((id) => !getDetails(id));
  if (missing.length) loadMany(missing).then(() => { if (token === renderToken) paint(rankRows(state), list, emptyText); });
}

function paint(rows, list, emptyText) {
  if (!rows.length) {
    list.innerHTML = `<p class="empty">${esc(emptyText)}</p>`;
    return;
  }
  list.innerHTML = rows.map(resultRow).join('');
  // Widths through CSSOM: the CSP blocks inline style attributes.
  list.querySelectorAll('[data-pct]').forEach((bar) => { bar.style.width = `${bar.dataset.pct}%`; });
}

function resultRow({ game, likers, likes, nopes, played, match: isMatch }, i) {
  const d = getDetails(game.id) || {};
  const cast = likes + nopes + played;
  const thumb = d.header ? `<img src="${esc(d.header)}" alt="">` : `<div class="thumb-ph">${esc(game.name)}</div>`;
  const link = storeUrl(game);
  const price = priceInfo(game);
  const playedHtml = played ? ` · ${playedLabel(played)}` : '';
  const likersHtml = likers.length ? ` · <span class="likers">${likers.map(esc).join(', ')}</span>` : '';
  return `
    <li class="${isMatch ? 'match' : ''}">
      <span class="rank" aria-label="${isMatch ? 'Match' : `Puesto ${i + 1}`}">${isMatch ? '💘' : i + 1}</span>
      ${thumb}
      <div>
        <p class="r-name">${esc(game.name)}</p>
        <p class="r-sub">${likes}/${cast} likes · ${nopes} nope${playedHtml}${likersHtml}</p>
        <div class="bar"><span data-pct="${cast ? Math.round((likes / cast) * 100) : 0}"></span></div>
      </div>
      <div class="r-right">
        <span class="price ${price.free ? 'free' : ''}">${price.html}</span>
        ${link ? `<a href="${esc(link)}" target="_blank" rel="noopener noreferrer">Ver tienda ↗</a>` : ''}
      </div>
    </li>`;
}
