// Room lifecycle: initial fetch, SSE connection, snapshot versioning and rendering by phase.
import { $, setLoading } from './dom.js';
import { api, openEvents } from './api.js';
import { loadSession, saveSession, clearSession } from './store.js';
import { resetMedia } from './media.js';
import { flyOut, resetCard } from './swipe.js';
import { showError } from './views/error.js';
import { showJoin, setJoinError } from './views/join.js';
import { renderHostLobby, renderPlayerLobby } from './views/lobby.js';
import { renderVoting, forgetRenderedGame, announceResult, currentGameId } from './views/voting.js';
import { renderResults } from './views/results.js';

const RECONNECT_DELAY_MS = 3000;

let active = null;

export const activeRoom = () => active;

export function enterRoom(code) {
  const room = { code, session: null, isHost: false, state: null, es: null, busy: false, disposed: false, pendingVote: null, retryTimer: null };
  active = room;
  showRoomBadge(code);
  boot(room);
  return () => leaveRoom(room);
}

function leaveRoom(room) {
  room.disposed = true;
  room.es?.close();
  clearTimeout(room.retryTimer);
  resetMedia();
  forgetRenderedGame();
  setConnBadge(false);
  $('roomBadge').hidden = true;
  $('progress').hidden = true;
  if (active === room) active = null;
}

async function boot(room) {
  setLoading(true, 'Entrando a la sala…');
  let snapshot;
  try {
    snapshot = await api.getRoom(room.code);
  } catch (err) {
    if (!room.disposed) failRoom(room, err.code);
    return;
  }
  if (room.disposed) return;
  setSession(room, loadSession(room.code));
  if (room.session && !snapshot.players.some((p) => p.id === room.session.playerId)) forgetSession(room);
  if (!room.session) return showJoinOrResults(room, snapshot);
  applySnapshot(room, snapshot);
  connect(room);
}

function setSession(room, session) {
  room.session = session;
  room.isHost = Boolean(session?.hostToken);
  document.body.classList.toggle('is-host', room.isHost);
  document.body.classList.toggle('is-phone', Boolean(session) && !room.isHost);
}

function forgetSession(room) {
  clearSession(room.code);
  setSession(room, null);
}

function failRoom(room, code) {
  if (code === 'room_not_found' || code === 'closed') clearSession(room.code);
  room.es?.close();
  resetMedia();
  setConnBadge(false);
  const retry = code === 'network' ? () => location.reload() : null;
  showError(code, { onRetry: retry });
}

function showJoinOrResults(room, snapshot) {
  if (snapshot.phase === 'finished') {
    return renderResults(snapshot, 'Esta votación ya terminó. Así quedó el ranking:');
  }
  showJoin(room.code, snapshot, (name) => joinRoom(room, name));
}

async function joinRoom(room, name) {
  try {
    const { playerToken, playerId } = await api.join(room.code, name);
    const session = { playerToken, playerId };
    saveSession(room.code, session);
    setSession(room, session);
    setLoading(true, 'Entrando a la sala…');
    connect(room); // the first SSE event carries the full snapshot
  } catch (err) {
    if (err.code === 'room_not_found' || err.code === 'room_finished') return failRoom(room, err.code);
    setJoinError(err.code);
  }
}

// ---------- live updates ----------

function connect(room) {
  room.es?.close();
  const es = openEvents(room.code);
  room.es = es;
  es.addEventListener('open', () => setConnBadge(false));
  es.addEventListener('state', (e) => onStateEvent(room, e));
  es.addEventListener('closed', () => failRoom(room, 'closed'));
  es.addEventListener('error', () => onStreamError(room, es));
}

function onStateEvent(room, event) {
  try {
    applySnapshot(room, JSON.parse(event.data));
  } catch (err) {
    console.error('[room] bad state event:', err);
  }
}

// EventSource retries by itself while CONNECTING; if it gives up (CLOSED) we retry by hand
// after checking the room still exists.
function onStreamError(room, es) {
  if (room.disposed || es !== room.es) return;
  setConnBadge(true);
  if (es.readyState === EventSource.CLOSED) scheduleReconnect(room);
}

function scheduleReconnect(room) {
  clearTimeout(room.retryTimer);
  room.retryTimer = setTimeout(async () => {
    if (room.disposed) return;
    try {
      applySnapshot(room, await api.getRoom(room.code));
      connect(room);
    } catch (err) {
      if (err.code === 'room_not_found') return failRoom(room, 'closed');
      scheduleReconnect(room);
    }
  }, RECONNECT_DELAY_MS);
}

function setConnBadge(visible) {
  $('connBadge').hidden = !visible;
}

function showRoomBadge(code) {
  $('roomBadge').textContent = `Sala ${code}`;
  $('roomBadge').hidden = false;
}

// ---------- snapshots & rendering ----------

// Returns false when the snapshot is stale (version ≤ current) and was ignored.
export function applySnapshot(room, snapshot) {
  if (room.disposed || !snapshot) return false;
  if (room.state && snapshot.version <= room.state.version) return false;
  const prev = room.state;
  room.state = snapshot;
  if (!room.busy) render(room, prev);
  return true;
}

function cardClosed(prev, next) {
  return Boolean(prev && prev.phase === 'voting' && next.index > prev.index && next.lastResult);
}

function render(room, prev) {
  if (cardClosed(prev, room.state)) return animateClose(room);
  renderPhase(room);
}

async function animateClose(room) {
  room.busy = true;
  const result = room.state.lastResult;
  announceResult(result);
  await flyOut(result.likes > result.nopes ? 'right' : 'left');
  room.busy = false;
  if (room.disposed) return;
  resetCard();
  renderPhase(room); // renders the latest snapshot, even if more arrived mid-animation
}

export function renderPhase(room) {
  if (room.busy || room.disposed || !room.state) return;
  const { phase, index, deck } = room.state;
  $('progress').hidden = phase !== 'voting';
  $('progress').textContent = `${Math.min(index + 1, deck.length)} / ${deck.length}`;
  if (phase !== 'voting') resetMedia();
  if (phase === 'lobby') return room.isHost ? renderHostLobby(room) : renderPlayerLobby(room);
  if (phase === 'voting') return renderVoting(room, myVote(room));
  renderResults(room.state);
}

export function myVote(room) {
  const gameId = currentGameId(room.state);
  if (room.pendingVote?.gameId === gameId) return room.pendingVote.vote;
  return room.state.votes[gameId]?.[room.session.playerId] ?? null;
}
