// User actions inside a room (vote, start, next, undo) and their input bindings.
import { $, toast } from './dom.js';
import { api } from './api.js';
import { errorMessage } from './errors.js';
import { activeRoom, applySnapshot, renderPhase, myVote } from './room.js';
import { currentGameId } from './views/voting.js';
import { setStartError } from './views/lobby.js';
import { toggleMute } from './media.js';
import { bindSwipe } from './swipe.js';
import { clearSession } from './store.js';
import { showError } from './views/error.js';

function canVote(room) {
  return Boolean(room && !room.busy && room.session && room.state?.phase === 'voting');
}

function handleActionError(room, err) {
  if (err.code === 'unauthorized') {
    clearSession(room.code);
    return showError('unauthorized', { onRetry: () => location.reload() });
  }
  toast(errorMessage(err.code));
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
    const snapshot = await api.vote(room.code, room.session.playerToken, gameId, vote);
    room.pendingVote = null;
    applyResponse(room, snapshot);
  } catch (err) {
    room.pendingVote = null;
    renderPhase(room);
    handleActionError(room, err);
  }
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
  m: toggleMute,
  M: toggleMute,
};
const HOST_KEYS = { n: forceNext, N: forceNext, z: undo, Z: undo, Backspace: undo };

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
  document.addEventListener('keydown', onKeydown);
  bindSwipe((vote) => castVote(vote), () => canVote(activeRoom()));
}
