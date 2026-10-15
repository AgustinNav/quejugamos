// Voting screen. Host and players share this DOM: body.is-host gates the host controls, the
// layout follows the viewport (media queries in styles.css).
import { $, esc, showScreen, announce, kickButton, toast } from '../dom.js';
import { getGame, getDetails, loadDetails, priceInfo, playersLabel, storeLinks, dealInfo, pcRequirements } from '../catalog.js';
import { renderMedia } from '../media.js';
import { showVoteStamp } from '../swipe.js';
import { renderUnder } from '../stack.js';

const VOTE_EMOJI = { like: '👍', nope: '👎', played: '✅' };

let renderedGameId = null;
let matchTimer = null;
let matchUntil = 0;
const MATCH_MS = 1800; // .match-overlay.play animation (styles.css)
let rejectTimer = null;
let rejectUntil = 0;
const REJECT_MS = 1500; // .nope-overlay.play animation (styles.css)

export const currentGameId = (state) => state.deck[state.index] ?? null;

function gameOrStub(id) {
  return getGame(id) || { id, name: id, players: [1, 1], platforms: [], tags: [], pitch: '' };
}

// `state` is what the screen shows: the server snapshot, or the optimistic view while a vote is in flight.
export function renderVoting(room, state, myVote) {
  const id = currentGameId(state);
  if (!id) return;
  if (id !== renderedGameId) showGame(id, state);
  renderMyVote(room, state, myVote);
  if (room.isHost) renderVoters(room, state);
  $('undoBtn').disabled = state.index === 0;
  showScreen('votingScreen');
}

export function forgetRenderedGame() {
  renderedGameId = null;
}

function showGame(id, state) {
  renderedGameId = id;
  const game = gameOrStub(id);
  $('gameReqs').open = false; // closed by default on every new card
  renderInfo(game);
  renderMedia(game);
  // Paint immediately with static data, then again once Steam details arrive.
  loadDetails(id).then((details) => {
    if (details && renderedGameId === id) {
      renderInfo(game);
      renderMedia(game, { force: true });
    }
  });
  renderNext(id, state.deck[state.index + 1]);
}

// The card underneath previews the next game; it repaints once that game's Steam cover arrives.
function renderNext(id, nextId) {
  renderUnder(nextId);
  if (!nextId) return;
  loadDetails(nextId).then((details) => {
    if (details && renderedGameId === id) renderUnder(nextId, { force: true });
  });
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
    .map(([label, url, kind, icon]) => linkButton(label, url, kind, icon))
    .join('');
  renderDeal(game);
  renderRequirements(game);
}

// Real <a> buttons; label/url are escaped, kind/icon come from catalog.js constants.
function linkButton(label, url, kind, icon) {
  return `<a class="link-btn ${kind}" href="${esc(url)}" target="_blank" rel="noopener noreferrer">`
    + `<span class="link-icon" aria-hidden="true">${icon}</span><span>${esc(label)}</span></a>`;
}

// The badge sits on the media (visible even while a trailer plays); the struck-through old price is in priceInfo.
function renderDeal(game) {
  const badge = $('dealBadge');
  const deal = dealInfo(game);
  badge.hidden = !deal;
  badge.classList.toggle('free', Boolean(deal?.free));
  badge.textContent = deal ? (deal.free ? 'GRATIS' : `🔥 -${deal.off}%`) : '';
}

function renderRequirements(game) {
  const reqs = pcRequirements(game);
  $('gameReqs').hidden = !reqs;
  if (!reqs) return $('gameReqsBody').replaceChildren();
  const groups = [['Mínimos', reqs.minimum], ['Recomendados', reqs.recommended]]
    .filter(([, lines]) => lines.length)
    .map(([title, lines]) => reqGroup(title, lines));
  $('gameReqsBody').replaceChildren(...groups);
}

function reqGroup(title, lines) {
  const group = document.createElement('div');
  group.className = 'req-group';
  const heading = document.createElement('h4');
  heading.textContent = title;
  const list = document.createElement('ul');
  list.append(...lines.map((line) => {
    const li = document.createElement('li');
    li.textContent = line;
    return li;
  }));
  group.append(heading, list);
  return group;
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

function renderMyVote(room, state, myVote) {
  $('voteLikeBtn').setAttribute('aria-pressed', String(myVote === 'like'));
  $('voteNopeBtn').setAttribute('aria-pressed', String(myVote === 'nope'));
  $('votePlayedBtn').setAttribute('aria-pressed', String(myVote === 'played'));
  $('voteBar').classList.toggle('has-vote', Boolean(myVote));
  showVoteStamp(myVote);
  const count = `${votedCount(state)}/${state.players.length}`;
  $('voteStatus').textContent = myVote
    ? `Votaste ${VOTE_EMOJI[myVote]} ✓ — esperando a los demás (${count}). Podés cambiarlo hasta que se cierre.`
    : `${hasKeyboardAndMouse() ? 'Tu voto: ← nope · → like · J ya lo jugué' : 'Deslizá la tarjeta o tocá 👎 / ✅ / 👍'} (${count} votaron)`;
}

// The hint follows the device, not the role: friends on a PC have the same keys as the host.
const hasKeyboardAndMouse = () => window.matchMedia('(hover: hover) and (pointer: fine)').matches;

// Shows who voted but never what they voted: the result is revealed when the card closes.
function renderVoters(room, state) {
  const voters = new Set(state.currentVoters);
  const items = state.players.map((p) => voterItem(p, voters.has(p.id), p.id === room.session.playerId));
  $('voterList').replaceChildren(...items);
  $('votersCount').textContent = `${votedCount(state)}/${state.players.length}`;
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
  matchUntil = Date.now() + MATCH_MS;
  matchTimer = setTimeout(hideMatch, MATCH_MS);
}

function hideMatch() {
  clearTimeout(matchTimer);
  matchTimer = null;
  $('matchOverlay').hidden = true;
}

/** Everyone who voted said nope (and the card was not ranked apart as already played). */
export const isRejectedByAll = (result) => result.likes === 0 && result.nopes > 0 && !result.playedOut;

export function showRejected(gameName) {
  const overlay = $('nopeOverlay');
  $('nopeGame').textContent = gameName;
  overlay.hidden = false;
  overlay.classList.remove('play');
  void overlay.offsetWidth; // restart the CSS animation
  overlay.classList.add('play');
  toast('Nadie lo quiere 💀', { ms: 3000 }); // role=alert: also what screen readers get
  clearTimeout(rejectTimer);
  rejectUntil = Date.now() + REJECT_MS;
  rejectTimer = setTimeout(hideRejected, REJECT_MS);
}

function hideRejected() {
  clearTimeout(rejectTimer);
  rejectTimer = null;
  $('nopeOverlay').hidden = true;
}

// Same as the toast (dom.js): a throttled timer in a hidden tab must not leave an overlay over the next card.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (matchTimer && Date.now() >= matchUntil) hideMatch();
  if (rejectTimer && Date.now() >= rejectUntil) hideRejected();
});

export function announceResult(result) {
  const game = gameOrStub(result.gameId);
  if (result.match) return showMatch(game.name);
  if (isRejectedByAll(result)) return showRejected(game.name);
  const played = result.played ? `, ${result.played} ya lo jugaron` : '';
  announce(`${game.name}: ${result.likes} like, ${result.nopes} nope${played}. Pasamos al siguiente.`);
}

export function gameName(id) {
  return gameOrStub(id).name;
}
