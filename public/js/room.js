// Room lifecycle: initial fetch, SSE connection, snapshot versioning and rendering by phase.
import { $, setLoading } from './dom.js';
import { api, openEvents } from './api.js';
import { loadSession, saveSession, clearSession } from './store.js';
import { resetMedia } from './media.js';
import { startKeepAlive } from './keepalive.js';
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
  const room = {
    code, session: null, isHost: false, state: null, es: null, busy: false, disposed: false,
    // myVote: own vote on the open card ({ gameId, vote }); snapshots only say who voted, not what.
    pendingVote: null, myVote: null, retryTimer: null, stopKeepAlive: startKeepAlive(code), onVisible: null,
  };
  room.onVisible = () => { if (document.visibilityState === 'visible') resync(room); };
  document.addEventListener('visibilitychange', room.onVisible);
  active = room;
  showRoomBadge(code);
  boot(room);
  return () => leaveRoom(room);
}

// Stops every async path (SSE, retries, keep-alive, visibility) so nothing repaints this room.
function disposeRoom(room) {
  room.disposed = true;
  room.stopKeepAlive();
  room.es?.close();
  clearTimeout(room.retryTimer);
  document.removeEventListener('visibilitychange', room.onVisible);
}

function leaveRoom(room) {
  disposeRoom(room);
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
  await loadMyVote(room);
  if (room.disposed) return;
  applySnapshot(room, snapshot);
  connect(room);
}

// Restores the own vote on the open card after a reload; failures just leave it unknown.
async function loadMyVote(room) {
  try {
    const me = await api.me(room.code, room.session.playerToken);
    room.myVote = { gameId: me.gameId, vote: me.vote };
  } catch (err) {
    console.warn('[room] could not load own vote:', err.code);
  }
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

const SESSION_ENDING_ERRORS = new Set(['room_not_found', 'closed', 'kicked', 'unauthorized']);
const RELOADABLE_ERRORS = { network: 'Reintentar', unauthorized: 'Volver a entrar', kicked: 'Volver a entrar' };

export function failRoom(room, code) {
  if (room.disposed) return;
  if (SESSION_ENDING_ERRORS.has(code)) clearSession(room.code);
  disposeRoom(room);
  resetMedia();
  setConnBadge(false);
  const retryLabel = RELOADABLE_ERRORS[code];
  showError(code, retryLabel ? { onRetry: () => location.reload(), retryLabel } : {});
}

const isKicked = (room, snapshot) => Boolean(room.session && !snapshot.players.some((p) => p.id === room.session.playerId));

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
  room.retryTimer = setTimeout(() => reconnect(room), RECONNECT_DELAY_MS);
}

async function reconnect(room) {
  clearTimeout(room.retryTimer);
  if (room.disposed) return;
  try {
    applySnapshot(room, await api.getRoom(room.code));
    connect(room);
  } catch (err) {
    if (err.code === 'room_not_found') return failRoom(room, 'closed');
    scheduleReconnect(room);
  }
}

/** Refetches the snapshot; used when the stream may have missed events (frozen phone, stale vote). */
export async function refreshRoom(room) {
  try {
    applySnapshot(room, await api.getRoom(room.code));
  } catch (err) {
    if (err.code === 'room_not_found') failRoom(room, 'closed');
    else console.warn('[room] refresh failed:', err.code);
  }
}

// A locked phone can freeze or kill the EventSource without firing `error`. On return, reopen a
// non-OPEN stream right away and always refetch once (a frozen stream may still report OPEN).
function resync(room) {
  if (room.disposed || !room.session) return;
  if (!room.es || room.es.readyState !== EventSource.OPEN) return void reconnect(room);
  refreshRoom(room);
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
  if (isKicked(room, snapshot)) {
    failRoom(room, 'kicked');
    return false;
  }
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
  // currentVoters is the authority on *whether* I voted (undo/kick clear votes server-side);
  // the locally kept vote only says which one.
  if (!room.state.currentVoters?.includes(room.session.playerId)) return null;
  return room.myVote?.gameId === gameId ? room.myVote.vote : null;
}

export function setMyVote(room, gameId, vote) {
  room.myVote = { gameId, vote };
}
