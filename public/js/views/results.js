// Ranking of the closed cards sorted by likes, matches (everyone liked it) highlighted. Cards where
// most voters had already played the game go in their own group; after a pause, the games nobody
// got to vote are listed too.
import { $, esc, showScreen, toast } from '../dom.js';
import { discountPercent, getGame, getDetails, loadMany, priceInfo, priceUsd, storeUrl } from '../catalog.js';
import { finishedEarly, idsToFetch, playedOutResults, rankedResults, unvotedGameIds } from '../ranking-data.js';
import { applyView, DEFAULT_PREFS, FILTERS, hasActiveFilters, needsAllDetails, normalizePrefs, SORTS } from '../ranking-sort.js';
import { buildExport } from '../ranking-export.js';
import { copyRankingText, savePoster } from '../ranking-share.js';

const PREFS_KEY = 'quejugamos:ranking-view';
const NAMES_KEY = 'quejugamos:export-names'; // separate from PREFS_KEY so "Quitar filtros" never touches it

const THUMBS_TO_FETCH = 10;
const UNVOTED_VISIBLE = 12;
let renderToken = 0;
let unvotedToken = 0;
const unvotedTried = new Set(); // ids already fetched once for the "Sin votar" list
let unvotedExpanded = false;
let prefs = loadPrefs();
let lastState = null;

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

function loadPrefs() {
  try {
    return normalizePrefs(JSON.parse(localStorage.getItem(PREFS_KEY)));
  } catch (err) {
    console.warn('[results] could not read the ranking view:', err);
    return { ...DEFAULT_PREFS };
  }
}

function loadIncludeNames() {
  try {
    return localStorage.getItem(NAMES_KEY) === '1';
  } catch (err) {
    console.warn('[results] could not read the export names choice:', err);
    return false;
  }
}

function saveIncludeNames(on) {
  try {
    localStorage.setItem(NAMES_KEY, on ? '1' : '0');
  } catch (err) {
    console.warn('[results] could not save the export names choice:', err);
  }
}

function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch (err) {
    console.warn('[results] could not save the ranking view:', err);
  }
}

// Default order = server-frozen likes/nopes (cheaper first on ties). `rank` is the position in that
// order and stays attached to the row, so re-sorting or filtering never renumbers a game.
function rankRows(state) {
  const rows = rankedResults(state)
    .filter((r) => getGame(r.gameId))
    .map((r) => ({ game: getGame(r.gameId), ...tally(state, r) }))
    .sort((a, b) => b.likes - a.likes || a.nopes - b.nopes || (priceUsd(a.game) ?? 99) - (priceUsd(b.game) ?? 99));
  return rows.map((row, i) => ({
    ...row,
    rank: i + 1,
    name: row.game.name,
    price: priceUsd(row.game),
    discount: discountPercent(row.game),
    maxPlayers: row.game.players[1],
  }));
}

export function renderResults(state, note = '') {
  const early = finishedEarly(state);
  if (!early) unvotedExpanded = false;
  const progress = early ? `Votación en pausa: ${state.index} de ${state.deck.length} juegos votados.` : '';
  $('resultsTitle').textContent = early ? '🏆 Ranking preliminar' : '🏆 Ranking final';
  $('resultsNote').textContent = [note, progress].filter(Boolean).join(' ');
  $('resumeVotingBtn').hidden = !early; // CSS also hides it for anyone but the host
  lastState = state;
  renderRanking(state, $('ranking'), undefined, { toolbar: true });
  syncToolbar(state);
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

/**
 * Paints the ranking of closed cards into `list` (also used by the partial-ranking sheet).
 * With `{ toolbar: true }` (results screen) the saved sort/filters apply; the sheet always shows everything.
 */
export function renderRanking(state, list, emptyText = 'No se llegó a votar ningún juego.', { toolbar = false } = {}) {
  const build = () => {
    const all = rankRows(state);
    return { all, shown: toolbar ? applyView(all, prefs) : all };
  };
  const first = build();
  paint(first, list, emptyText, toolbar);
  // Thumbnails/prices arrive lazily: the top of the list, or every row when the view depends on price.
  const token = ++renderToken;
  const wanted = toolbar && needsAllDetails(prefs) ? first.all : first.shown.slice(0, THUMBS_TO_FETCH);
  const missing = wanted.map((r) => r.game.id).filter((id) => !getDetails(id));
  if (missing.length) loadMany(missing).then(() => { if (token === renderToken) paint(build(), list, emptyText, toolbar); });
}

function paint({ all, shown }, list, emptyText, toolbar) {
  const filteredOut = toolbar && all.length > 0 && shown.length === 0;
  if (toolbar) {
    $('rankFilteredEmpty').hidden = !filteredOut;
    $('rankCount').textContent = hasActiveFilters(prefs) && all.length ? `${shown.length} de ${all.length}` : '';
  }
  if (!shown.length) {
    list.innerHTML = filteredOut ? '' : `<p class="empty">${esc(emptyText)}</p>`;
    return;
  }
  list.innerHTML = shown.map(resultRow).join('');
  // Widths through CSSOM: the CSP blocks inline style attributes.
  list.querySelectorAll('[data-pct]').forEach((bar) => { bar.style.width = `${bar.dataset.pct}%`; });
}

function resultRow({ game, likers, likes, nopes, played, match: isMatch, rank }) {
  const d = getDetails(game.id) || {};
  const cast = likes + nopes + played;
  const thumb = d.header ? `<img src="${esc(d.header)}" alt="">` : `<div class="thumb-ph">${esc(game.name)}</div>`;
  const link = storeUrl(game);
  const price = priceInfo(game);
  const playedHtml = played ? ` · ${playedLabel(played)}` : '';
  const likersHtml = likers.length ? ` · <span class="likers">${likers.map(esc).join(', ')}</span>` : '';
  return `
    <li class="${isMatch ? 'match' : ''}">
      <span class="rank" aria-label="${isMatch ? 'Match' : `Puesto ${rank}`}">${isMatch ? '💘' : rank}</span>
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

// ---- Sort/filter bar and export actions (static markup in index.html) ----

function syncToolbar(state) {
  const hasRanked = rankRows(state).length > 0;
  $('rankTools').hidden = !hasRanked;
  $('rankExport').hidden = !hasRanked && playedOutResults(state).length === 0;
  $('rankSort').value = prefs.sort;
  FILTERS.forEach(({ key }) => $(`rankFilter-${key}`).setAttribute('aria-pressed', String(prefs[key])));
}

function status(message) {
  $('rankStatus').textContent = '';
  setTimeout(() => { $('rankStatus').textContent = message; }, 50); // re-announce repeated messages
  toast(message);
}

function exportModel() {
  return buildExport(lastState, { nameOf: (id) => getGame(id)?.name, priceOf: (id) => (getGame(id) ? priceUsd(getGame(id)) : null), includeNames: $('rankNames').checked });
}

async function run(button, work, doneText, failText) {
  button.disabled = true;
  try {
    const outcome = await work();
    if (outcome !== 'cancelled') status(doneText);
  } catch (err) {
    console.warn('[results] export failed:', err);
    status(failText);
  } finally {
    button.disabled = false;
  }
}

export function bindResultsTools(getState) {
  const sort = $('rankSort');
  sort.replaceChildren(...SORTS.map(({ key, label }) => new Option(label, key)));
  const apply = () => {
    savePrefs();
    const state = getState();
    if (state) { renderRanking(state, $('ranking'), undefined, { toolbar: true }); syncToolbar(state); }
  };
  sort.addEventListener('change', () => { prefs = normalizePrefs({ ...prefs, sort: sort.value }); apply(); });
  FILTERS.forEach(({ key }) => $(`rankFilter-${key}`).addEventListener('click', () => {
    prefs = normalizePrefs({ ...prefs, [key]: !prefs[key] });
    apply();
  }));
  $('rankClearBtn').addEventListener('click', () => {
    prefs = normalizePrefs({ sort: prefs.sort });
    apply();
    $('rankSort').focus();
  });
  const names = $('rankNames');
  names.checked = loadIncludeNames();
  names.addEventListener('change', () => saveIncludeNames(names.checked));
  $('rankSaveBtn').addEventListener('click', () => {
    if (lastState) run($('rankSaveBtn'), () => savePoster(exportModel()), 'Ranking guardado', 'No se pudo guardar el ranking');
  });
  $('rankCopyBtn').addEventListener('click', () => {
    if (lastState) run($('rankCopyBtn'), () => copyRankingText(exportModel()), 'Copiado', 'No se pudo copiar');
  });
}
