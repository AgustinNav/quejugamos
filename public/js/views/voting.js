// Voting screen. Host and phone share this DOM; body.is-host / body.is-phone switch the layout.
import { $, esc, showScreen, announce, kickButton } from '../dom.js';
import { getGame, getDetails, loadDetails, priceInfo, playersLabel, storeLinks } from '../catalog.js';
import { renderMedia } from '../media.js';
import { showVoteStamp } from '../swipe.js';

let renderedGameId = null;
let matchTimer = null;

export const currentGameId = (state) => state.deck[state.index] ?? null;

function gameOrStub(id) {
  return getGame(id) || { id, name: id, players: [1, 1], platforms: [], tags: [], pitch: '' };
}

export function renderVoting(room, myVote) {
  const id = currentGameId(room.state);
  if (!id) return;
  if (id !== renderedGameId) showGame(id, room.state);
  renderMyVote(room, myVote);
  if (room.isHost) renderVoters(room);
  $('undoBtn').disabled = room.state.index === 0;
  showScreen('votingScreen');
}

export function forgetRenderedGame() {
  renderedGameId = null;
}

function showGame(id, state) {
  renderedGameId = id;
  const game = gameOrStub(id);
  renderInfo(game);
  renderMedia(game);
  // Paint immediately with static data, then again once Steam details arrive.
  loadDetails(id).then((details) => {
    if (details && renderedGameId === id) {
      renderInfo(game);
      renderMedia(game, { force: true });
    }
  });
  const nextId = state.deck[state.index + 1];
  if (nextId) loadDetails(nextId);
}

function renderInfo(game) {
  const price = priceInfo(game);
  $('gameName').textContent = game.name;
  $('gamePrice').innerHTML = price.html;
  $('gamePrice').className = `price ${price.free ? 'free' : ''}`;
  $('gameMeta').innerHTML = metaPills(game).join('');
  $('gameTags').innerHTML = game.tags.map((t) => `<span class="tag">#${esc(t)}</span>`).join(' ');
  $('gamePitch').textContent = game.pitch;
  const d = getDetails(game.id) || {};
  $('gameSteamDesc').textContent = d.shortDescription ? `Steam: “${d.shortDescription}”` : '';
  $('gameLinks').innerHTML = storeLinks(game)
    .map(([label, url]) => `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`)
    .join('');
}

function metaPills(game) {
  const d = getDetails(game.id) || {};
  const cross = { true: ['good', '✓ Crossplay'], false: ['bad', '✕ Sin crossplay'] }[game.crossplay] || ['warn', '? Crossplay: verificar'];
  const pills = [
    `<span class="pill players">${playersLabel(game)}</span>`,
    ...game.platforms.map((p) => `<span class="pill extra">${esc(p)}</span>`),
    `<span class="pill extra ${cross[0]}">${cross[1]}</span>`,
  ];
  if (d.reviews) pills.push(`<span class="pill extra">⭐ ${Number(d.reviews).toLocaleString('es-AR')} reseñas</span>`);
  if (d.metacritic) pills.push(`<span class="pill extra">MC ${Number(d.metacritic)}</span>`);
  return pills;
}

// Open-card votes are private: the snapshot only lists who already voted.
function votedCount(state) {
  return state.currentVoters.length;
}

function renderMyVote(room, myVote) {
  $('voteLikeBtn').setAttribute('aria-pressed', String(myVote === 'like'));
  $('voteNopeBtn').setAttribute('aria-pressed', String(myVote === 'nope'));
  $('voteBar').classList.toggle('has-vote', Boolean(myVote));
  showVoteStamp(myVote);
  const count = `${votedCount(room.state)}/${room.state.players.length}`;
  $('voteStatus').textContent = myVote
    ? `Votaste ${myVote === 'like' ? '👍' : '👎'} ✓ — esperando a los demás (${count}). Podés cambiarlo hasta que se cierre.`
    : `${room.isHost ? 'Tu voto: ← nope · → like' : 'Deslizá la tarjeta o tocá 👎 / 👍'} (${count} votaron)`;
}

// Shows who voted but never what they voted: the result is revealed when the card closes.
function renderVoters(room) {
  const voters = new Set(room.state.currentVoters);
  const items = room.state.players.map((p) => voterItem(p, voters.has(p.id), p.id === room.session.playerId));
  $('voterList').replaceChildren(...items);
  $('votersCount').textContent = `${votedCount(room.state)}/${room.state.players.length}`;
}

function voterItem(player, voted, isMe) {
  const li = document.createElement('li');
  li.className = voted ? 'voted' : 'pending';
  const name = document.createElement('span');
  name.className = 'voter-name';
  name.textContent = isMe ? `${player.name} (vos)` : player.name;
  const mark = document.createElement('span');
  mark.className = 'voter-mark';
  mark.textContent = voted ? '✓' : '…';
  mark.setAttribute('aria-label', voted ? 'ya votó' : 'pendiente');
  li.append(name, mark);
  if (!player.isHost) li.append(kickButton(player)); // host-only panel
  return li;
}

export function showMatch(gameName) {
  const overlay = $('matchOverlay');
  $('matchGame').textContent = `${gameName} — les gusta a todos`;
  overlay.hidden = false;
  overlay.classList.remove('play');
  void overlay.offsetWidth; // restart the CSS animation
  overlay.classList.add('play');
  announce(`¡Match! ${gameName} les gusta a todos.`);
  clearTimeout(matchTimer);
  matchTimer = setTimeout(() => { overlay.hidden = true; }, 1800);
}

export function announceResult(result) {
  const game = gameOrStub(result.gameId);
  if (result.match) return showMatch(game.name);
  announce(`${game.name}: ${result.likes} like, ${result.nopes} nope. Pasamos al siguiente.`);
}

export function gameName(id) {
  return gameOrStub(id).name;
}
