// Final ranking: closed cards sorted by likes, matches (everyone liked it) highlighted.
import { $, esc, showScreen } from '../dom.js';
import { getGame, getDetails, loadMany, priceInfo, priceUsd, storeUrl } from '../catalog.js';

const THUMBS_TO_FETCH = 10;
let renderToken = 0;

function tally(state, gameId) {
  const votes = state.votes[gameId] || {};
  const likers = state.players.filter((p) => votes[p.id] === 'like').map((p) => p.name);
  const nopes = state.players.filter((p) => votes[p.id] === 'nope').length;
  return { likers, likes: likers.length, nopes };
}

function rankRows(state) {
  return state.deck.slice(0, state.index)
    .map((id) => getGame(id))
    .filter(Boolean)
    .map((game) => ({ game, ...tally(state, game.id) }))
    .sort((a, b) => b.likes - a.likes || a.nopes - b.nopes || (priceUsd(a.game) ?? 99) - (priceUsd(b.game) ?? 99));
}

export function renderResults(state, note = '') {
  const rows = rankRows(state);
  $('resultsNote').textContent = note;
  paint(rows, state.players.length);
  showScreen('resultsScreen');
  // Thumbnails/prices for the top of the ranking; repaint once they arrive.
  const token = ++renderToken;
  const missing = rows.slice(0, THUMBS_TO_FETCH).map((r) => r.game.id).filter((id) => !getDetails(id));
  if (missing.length) loadMany(missing).then(() => { if (token === renderToken) paint(rankRows(state), state.players.length); });
}

function paint(rows, total) {
  if (!rows.length) {
    $('ranking').innerHTML = '<p class="empty">No se llegó a votar ningún juego.</p>';
    return;
  }
  $('ranking').innerHTML = rows.map((row, i) => resultRow(row, i, total)).join('');
  // Widths through CSSOM: the CSP blocks inline style attributes.
  $('ranking').querySelectorAll('[data-pct]').forEach((bar) => { bar.style.width = `${bar.dataset.pct}%`; });
}

function resultRow({ game, likers, likes, nopes }, i, total) {
  const d = getDetails(game.id) || {};
  const isMatch = total > 0 && likes === total;
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
        <p class="r-sub">${likes}/${total} likes · ${nopes} nope${likersHtml}</p>
        <div class="bar"><span data-pct="${total ? Math.round((likes / total) * 100) : 0}"></span></div>
      </div>
      <div class="r-right">
        <span class="price ${price.free ? 'free' : ''}">${price.html}</span>
        ${link ? `<a href="${esc(link)}" target="_blank" rel="noopener noreferrer">Ver tienda ↗</a>` : ''}
      </div>
    </li>`;
}
