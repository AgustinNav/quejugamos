// User actions inside a room (vote, start, next, undo) and their input bindings.
import { $, toast } from './dom.js';
import { api } from './api.js';
import { errorMessage } from './errors.js';
import {
  activeRoom, applySnapshot, beginOptimisticAdvance, failRoom, refreshRoom, renderPhase, rollbackOptimistic, myVote, setMyVote,
} from './room.js';
import { currentGameId } from './views/voting.js';
import { setStartError } from './views/lobby.js';
import { bindRankingSheet } from './ranking-sheet.js';
import { bindUnvoted } from './views/results.js';
import { toggleMute, volumeUp, volumeDown, openCardGallery } from './media.js';
import { bindSwipe, isCardOut, returnCard } from './swipe.js';
import { closesCard } from './gesture.js';

// The UI was behind the server (e.g. the SSE stream died while the phone was locked).
const STALE_STATE_ERRORS = new Set(['not_current_game', 'not_voting']);

// isCardOut: the own swipe threw the card and its vote is still in flight.
// room.optimistic: the next card is already on screen but the server has not confirmed the advance.
function canVote(room) {
  return Boolean(room && !room.busy && !room.optimistic && room.session && room.state?.phase === 'voting' && !isCardOut());
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

// Only the last missing vote (and not the last card of the deck, whose next screen is the ranking,
// which exists only once the server froze the results) advances the screen before the server answers.
function advancesOptimistically(state, playerId) {
  return closesCard(state, playerId) && state.index + 1 < state.deck.length;
}

// A failed request leaves the UI possibly ahead of or behind the server: refetch unless handleActionError does.
const resyncsAfterError = (code) => code !== 'unauthorized' && !STALE_STATE_ERRORS.has(code);

export async function castVote(vote) {
  const room = activeRoom();
  if (!canVote(room) || myVote(room) === vote) return;
  const gameId = currentGameId(room.state);
  room.pendingVote = { gameId, vote };
  renderPhase(room); // optimistic: the button lights up right away
  if (advancesOptimistically(room.state, room.session.playerId)) beginOptimisticAdvance(room, vote);
  const advance = room.optimistic;
  try {
    const { myVote: ownVote, ...snapshot } = await api.vote(room.code, room.session.playerToken, gameId, vote);
    room.pendingVote = null;
    setMyVote(room, currentGameId(snapshot), ownVote);
    applyResponse(room, snapshot);
  } catch (err) {
    room.pendingVote = null;
    rollbackOptimistic(room);
    renderPhase(room);
    handleActionError(room, err);
    if (resyncsAfterError(err.code)) refreshRoom(room);
  } finally {
    // Safety net: an advance the response did not settle must not leave the next card on screen.
    if (advance && room.optimistic === advance) rollbackOptimistic(room);
    // A thrown card (last card of the deck) whose vote did not close it comes back. When it did
    // close, the room's close animation is running (busy) and owns the card.
    if (!room.busy && !room.disposed && !room.optimistic) returnCard();
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

// Pauses voting for everyone: the ranking so far is shown and the open card is set aside.
// Reversible ("Seguir votando" = undo), so there is no confirmation.
export const finishVoting = () => hostAction(api.finish);

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
  try {
    applyResponse(room, await api.start(room.code, room.session.hostToken, filters));
  } catch (err) {
    if (err.code === 'unauthorized') return handleActionError(room, err);
    setStartError(err.code);
  }
}

const KEYS = {
  ArrowLeft: () => castVote('nope'),
  ArrowRight: () => castVote('like'),
  j: () => castVote('played'),
  J: () => castVote('played'),
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
  $('votePlayedBtn').addEventListener('click', () => castVote('played'));
  $('nextBtn').addEventListener('click', forceNext);
  $('undoBtn').addEventListener('click', undo);
  $('finishBtn').addEventListener('click', finishVoting);
  $('resumeVotingBtn').addEventListener('click', undo);
  bindRankingSheet(() => activeRoom()?.state);
  document.querySelectorAll('[data-close-room]').forEach((btn) => btn.addEventListener('click', closeRoom));
  bindUnvoted(() => activeRoom()?.state);
  $('voterList').addEventListener('click', onKickClick);
  $('lobbyPlayers').addEventListener('click', onKickClick);
  document.addEventListener('keydown', onKeydown);
  bindSwipe({ onSwipe: swipeVote, canSwipe: () => canVote(activeRoom()) });
}
