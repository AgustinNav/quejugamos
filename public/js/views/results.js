// Final ranking: closed cards sorted by likes, matches (everyone liked it) highlighted; games skipped
// as already played go in their own group below.
import { $, esc, showScreen } from '../dom.js';
import { getGame, getDetails, loadMany, priceInfo, priceUsd, storeUrl } from '../catalog.js';

const THUMBS_TO_FETCH = 10;
let renderToken = 0;

// Counts come only from the server's frozen per-card result (never recomputed from `votes`, see
// CLAUDE.md Mistakes Log); `votes` only supplies the names of likers still in the room.
function tally(state, gameId) {
  const votes = state.votes[gameId] || {};
  const likers = state.players.filter((p) => votes[p.id] === 'like').map((p) => p.name);
  const { likes, nopes, match } = state.results[gameId];
  return { likers, likes, nopes, match };
}

// Cards skipped with "Ya lo jugamos" are listed apart and never ranked (nobody voted them).
const closedIds = (state) => state.deck.slice(0, state.index).filter((id) => state.results[id]);

function playedGames(state) {
  return closedIds(state).filter((id) => state.results[id].played).map((id) => getGame(id)).filter(Boolean);
}

function renderPlayed(state) {
  const games = playedGames(state);
  $('playedGroup').hidden = games.length === 0;
  $('playedList').innerHTML = games.map((game) => `<li><span aria-hidden="true">✅</span> ${esc(game.name)}</li>`).join('');
}

function rankRows(state) {
  return closedIds(state)
    .filter((id) => !state.results[id].played)
    .map((id) => getGame(id))
    .filter(Boolean)
    .map((game) => ({ game, ...tally(state, game.id) }))
    .sort((a, b) => b.likes - a.likes || a.nopes - b.nopes || (priceUsd(a.game) ?? 99) - (priceUsd(b.game) ?? 99));
}

// The host ended voting before the deck ran out: deck[index] was discarded, not ranked.
export const finishedEarly = (state) => state.phase === 'finished' && state.index < state.deck.length;

export function renderResults(state, note = '') {
  const early = finishedEarly(state) ? `La votación terminó antes: ${state.index} de ${state.deck.length} juegos votados.` : '';
  $('resultsNote').textContent = [note, early].filter(Boolean).join(' ');
  $('resumeVotingBtn').hidden = !finishedEarly(state); // CSS also hides it for anyone but the host
  renderRanking(state, $('ranking'));
  renderPlayed(state);
  showScreen('resultsScreen');
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

function resultRow({ game, likers, likes, nopes, match: isMatch }, i) {
  const d = getDetails(game.id) || {};
  const voters = likes + nopes;
  const thumb = d.header ? `<img src="${esc(d.header)}" alt="">` : `<div class="thumb-ph">${esc(game.name)}</div>`;
  const link = storeUrl(game);
  const price = priceInfo(game);
  const likersHtml = likers.length ? ` · <span class="likers">${likers.map(esc).join(', ')}</span>` : '';
  return `
    <li class="${isMatch ? 'match' : ''}">
      <span class="rank" aria-label="${isMatch ? 'Match' : `Puesto ${i + 1}`}">${isMatch ? '💘' : i + 1}</span>
      ${thumb}
      <div>
        <p class="r-name">${esc(game.name)}</p>
        <p class="r-sub">${likes}/${voters} likes · ${nopes} nope${likersHtml}</p>
        <div class="bar"><span data-pct="${voters ? Math.round((likes / voters) * 100) : 0}"></span></div>
      </div>
      <div class="r-right">
        <span class="price ${price.free ? 'free' : ''}">${price.html}</span>
        ${link ? `<a href="${esc(link)}" target="_blank" rel="noopener noreferrer">Ver tienda ↗</a>` : ''}
      </div>
    </li>`;
}
