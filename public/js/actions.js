// User actions inside a room (vote, start, next, undo) and their input bindings.
import { $, toast } from './dom.js';
import { api } from './api.js';
import { errorMessage } from './errors.js';
import { activeRoom, applySnapshot, failRoom, refreshRoom, renderPhase, myVote, setMyVote } from './room.js';
import { currentGameId, gameName } from './views/voting.js';
import { setStartError } from './views/lobby.js';
import { bindRankingSheet } from './ranking-sheet.js';
import { bindPlayedHint, excludedGameIds } from './played.js';
import { toggleMute, volumeUp, volumeDown, openCardGallery } from './media.js';
import { bindSwipe, isCardOut, returnCard } from './swipe.js';
import { closesCard } from './gesture.js';

// The UI was behind the server (e.g. the SSE stream died while the phone was locked).
const STALE_STATE_ERRORS = new Set(['not_current_game', 'not_voting']);

// isCardOut: the own swipe threw the card and its vote is still in flight.
function canVote(room) {
  return Boolean(room && !room.busy && room.session && room.state?.phase === 'voting' && !isCardOut());
}

async function handleActionError(room, err) {
  if (err.code === 'unauthorized') {
    // Most likely the host kicked us and the SSE event hasn't arrived: the refresh shows that screen.
    await refreshRoom(room);
    return failRoom(room, 'unauthorized');
  }
  toast(errorMessage(err.code));
  if (STALE_STATE_ERRORS.has(err.code)) refreshRoom(room);
}

// Applies the snapshot returned by a POST; if SSE already delivered it, just re-render.
function applyResponse(room, snapshot) {
  if (!applySnapshot(room, snapshot)) renderPhase(room);
}

export async function castVote(vote) {
  const room = activeRoom();
  if (!canVote(room) || myVote(room) === vote) return;
  const gameId = currentGameId(room.state);
  room.pendingVote = { gameId, vote };
  renderPhase(room); // optimistic: the button lights up right away
  try {
    const { myVote: ownVote, ...snapshot } = await api.vote(room.code, room.session.playerToken, gameId, vote);
    room.pendingVote = null;
    setMyVote(room, currentGameId(snapshot), ownVote);
    applyResponse(room, snapshot);
  } catch (err) {
    room.pendingVote = null;
    renderPhase(room);
    handleActionError(room, err);
  } finally {
    // A thrown card whose vote did not close it (error, or someone joined meanwhile) comes back.
    // When it did close, the room's close animation is running (busy) and owns the card.
    if (!room.busy && !room.disposed) returnCard();
  }
}

// Swipe release: votes, and tells the card to leave only if this vote is the last one missing.
function swipeVote(vote) {
  const room = activeRoom();
  if (!canVote(room) || myVote(room) === vote) return 'stay';
  const leaves = closesCard(room.state, room.session.playerId);
  castVote(vote);
  return leaves ? 'leave' : 'stay';
}

async function hostAction(call) {
  const room = activeRoom();
  if (!room?.isHost || room.busy) return;
  try {
    applyResponse(room, await call(room.code, room.session.hostToken));
  } catch (err) {
    handleActionError(room, err);
  }
}

export const forceNext = () => hostAction(api.next);
export const undo = () => hostAction(api.undo);

// Ends voting for everyone; the open card is discarded. Undo right after brings it back.
export function finishVoting() {
  if (!activeRoom()?.isHost) return;
  if (!window.confirm('¿Terminar la votación para todos? Se muestra el ranking con lo votado hasta ahora.')) return;
  hostAction(api.finish);
}

// "Ya lo jugamos": any player skips the open card for the whole room (it never counts as a match).
export async function skipCurrentGame() {
  const room = activeRoom();
  if (!canVote(room) || room.skipping) return;
  const gameId = currentGameId(room.state);
  const question = `¿Saltear «${gameName(gameId)}» para todos? No va a volver a aparecer en las próximas salas del host.`;
  if (!window.confirm(question)) return;
  room.skipping = true;
  $('playedBtn').disabled = true;
  try {
    applyResponse(room, await api.skip(room.code, room.session.playerToken, gameId));
  } catch (err) {
    handleActionError(room, err);
  } finally {
    room.skipping = false;
    $('playedBtn').disabled = false;
  }
}

// Host deletes the room for everyone: names and votes are gone from the server right away.
export async function closeRoom() {
  const room = activeRoom();
  if (!room?.isHost || room.closing) return;
  if (!window.confirm('¿Cerrar la sala para todos? Se borran los nombres y los votos.')) return;
  room.closing = true;
  try {
    await api.close(room.code, room.session.hostToken);
    failRoom(room, 'closed'); // the `closed` SSE event may also arrive: failRoom is idempotent
  } catch (err) {
    if (err.code === 'room_not_found') return failRoom(room, 'closed');
    handleActionError(room, err);
  } finally {
    room.closing = false;
  }
}

// Removes a duplicate/abandoned player so they stop blocking auto-advance and matches.
export function kickPlayer(playerId) {
  const room = activeRoom();
  const player = room?.state?.players.find((p) => p.id === playerId);
  if (!room?.isHost || !player || player.isHost) return;
  if (!window.confirm(`¿Sacar a ${player.name} de la sala?`)) return;
  hostAction((code, token) => api.kick(code, token, playerId));
}

function onKickClick(e) {
  const playerId = e.target.closest?.('[data-kick]')?.dataset.kick;
  if (playerId) kickPlayer(playerId);
}

export async function startVoting(filters) {
  const room = activeRoom();
  if (!room?.isHost) return;
  // Games this browser's rooms already skipped as played stay out of the deck.
  const excludeGameIds = excludedGameIds();
  const body = excludeGameIds.length ? { ...filters, excludeGameIds } : filters;
  try {
    applyResponse(room, await api.start(room.code, room.session.hostToken, body));
  } catch (err) {
    if (err.code === 'unauthorized') return handleActionError(room, err);
    setStartError(err.code);
  }
}

const KEYS = {
  ArrowLeft: () => castVote('nope'),
  ArrowRight: () => castVote('like'),
  m: toggleMute,
  M: toggleMute,
  '+': volumeUp,
  '=': volumeUp,
  '-': volumeDown,
  _: volumeDown,
  g: openCardGallery,
  G: openCardGallery,
};
const HOST_KEYS = { n: forceNext, N: forceNext, z: undo, Z: undo, Backspace: undo, f: finishVoting, F: finishVoting };

function onKeydown(e) {
  const room = activeRoom();
  if (room?.state?.phase !== 'voting' || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target.closest?.('input, textarea, select')) return;
  const action = KEYS[e.key] || (room.isHost && HOST_KEYS[e.key]);
  if (!action) return;
  e.preventDefault();
  action();
}

export function bindActions() {
  $('voteLikeBtn').addEventListener('click', () => castVote('like'));
  $('voteNopeBtn').addEventListener('click', () => castVote('nope'));
  $('nextBtn').addEventListener('click', forceNext);
  $('undoBtn').addEventListener('click', undo);
  $('playedBtn').addEventListener('click', skipCurrentGame);
  $('finishBtn').addEventListener('click', finishVoting);
  $('resumeVotingBtn').addEventListener('click', undo);
  bindRankingSheet(() => activeRoom()?.state);
  document.querySelectorAll('[data-close-room]').forEach((btn) => btn.addEventListener('click', closeRoom));
  bindPlayedHint();
  $('voterList').addEventListener('click', onKickClick);
  $('lobbyPlayers').addEventListener('click', onKickClick);
  document.addEventListener('keydown', onKeydown);
  bindSwipe({ onSwipe: swipeVote, canSwipe: () => canVote(activeRoom()) });
}
