// Room lifecycle: initial fetch, SSE connection, snapshot versioning and rendering by phase.
import { $, setLoading, toast } from './dom.js';
import { ApiError, api, isMemberSnapshot, openEvents } from './api.js';
import { loadSession, saveSession, clearSession } from './store.js';
import { markGuest } from './attribution.js';
import { resetMedia } from './media.js';
import { startKeepAlive } from './keepalive.js';
import { flyOut, playedOut, prepareNextCard, resetCard, revealNextCard } from './swipe.js';
import { showError } from './views/error.js';
import { showJoin, setJoinError } from './views/join.js';
import { renderHostLobby, renderPlayerLobby } from './views/lobby.js';
import { renderVoting, forgetRenderedGame, announceResult, currentGameId, gameName } from './views/voting.js';
import { renderResults } from './views/results.js';
import { closeRankingSheet, syncRankingSheet } from './ranking-sheet.js';

const RECONNECT_DELAY_MS = 3000;
const MAX_RECONNECT_DELAY_MS = 30_000;

let active = null;

export const activeRoom = () => active;

export function enterRoom(code) {
  const room = {
    code, session: null, isHost: false, state: null, es: null, busy: false, disposed: false,
    // myVote: own vote on the open card ({ gameId, vote }); snapshots only say who voted, not what.
    pendingVote: null, myVote: null, retryTimer: null, stopKeepAlive: startKeepAlive(code), onVisible: null,
    // Stream reconnection: connectAttempt drops stale ticket requests, retries drives the backoff,
    // authRetries allows one re-ticket after a 401 before treating the session as gone.
    connectAttempt: 0, retries: 0, authRetries: 0,
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
  closeRankingSheet({ resume: false });
  room.stopKeepAlive();
  room.es?.close();
  clearTimeout(room.retryTimer);
  document.removeEventListener('visibilitychange', room.onVisible);
}

function leaveRoom(room) {
  disposeRoom(room);
  resetMedia();
  resetCard();
  forgetRenderedGame();
  setConnBadge(false);
  $('roomBadge').hidden = true;
  $('progress').hidden = true;
  if (active === room) active = null;
}

async function boot(room) {
  setLoading(true, 'Entrando a la sala…');
  setSession(room, loadSession(room.code));
  let snapshot;
  try {
    snapshot = await api.getRoom(room.code, room.session?.playerToken);
  } catch (err) {
    if (!room.disposed) failRoom(room, err.code);
    return;
  }
  if (room.disposed) return;
  // Without a valid token of this room the server only sends the public view (no names).
  if (!isMemberSnapshot(snapshot) || isKicked(room, snapshot)) {
    forgetSession(room);
    return showJoinOrFinished(room, snapshot);
  }
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
  $('progress').hidden = true;
  const retryLabel = RELOADABLE_ERRORS[code];
  showError(code, retryLabel ? { onRetry: () => location.reload(), retryLabel } : {});
}

const isKicked = (room, snapshot) => Boolean(room.session && !snapshot.players.some((p) => p.id === room.session.playerId));

// The ranking (names, votes) is only for members: outsiders of a finished room get the notice.
function showJoinOrFinished(room, publicView) {
  if (publicView.phase === 'finished') return failRoom(room, 'room_finished');
  showJoin(room.code, publicView, (name) => joinRoom(room, name));
}

async function joinRoom(room, name) {
  try {
    const { playerToken, playerId } = await api.join(room.code, name);
    const session = { playerToken, playerId };
    saveSession(room.code, session);
    markGuest();
    setSession(room, session);
    setLoading(true, 'Entrando a la sala…');
    connect(room); // the first SSE event carries the full snapshot
  } catch (err) {
    if (err.code === 'room_not_found' || err.code === 'room_finished') return failRoom(room, err.code);
    setJoinError(err.code);
  }
}

// ---------- live updates ----------

// Every connect (first one and each reconnect) trades the token for a fresh single-use ticket:
// the token never goes in a URL.
async function connect(room) {
  closeStream(room);
  const attempt = ++room.connectAttempt;
  let ticket;
  try {
    ({ ticket } = await api.streamTicket(room.code, room.session.playerToken));
  } catch (err) {
    if (!room.disposed && attempt === room.connectAttempt) onTicketError(room, err.code);
    return;
  }
  if (room.disposed || attempt !== room.connectAttempt) return;
  const es = openEvents(room.code, ticket);
  room.es = es;
  es.addEventListener('open', () => onStreamOpen(room, es));
  es.addEventListener('state', (e) => onStateEvent(room, e));
  es.addEventListener('closed', () => failRoom(room, 'closed'));
  es.addEventListener('error', () => onStreamError(room, es));
}

function closeStream(room) {
  room.es?.close();
  room.es = null;
}

function onStreamOpen(room, es) {
  if (es !== room.es) return;
  room.retries = 0;
  room.authRetries = 0;
  setConnBadge(false);
}

function onTicketError(room, code) {
  if (code === 'room_not_found') return failRoom(room, 'closed');
  if (code === 'unauthorized') {
    room.authRetries += 1;
    if (room.authRetries > 1) return failRoom(room, 'unauthorized');
    return void connect(room);
  }
  setConnBadge(true);
  scheduleReconnect(room);
}

function onStateEvent(room, event) {
  try {
    applySnapshot(room, JSON.parse(event.data));
  } catch (err) {
    console.error('[room] bad state event:', err);
  }
}

// Native auto-reconnect would reuse the URL, whose ticket is already spent (401). We take over:
// close the stream and reconnect by hand (room check + fresh ticket) with backoff.
function onStreamError(room, es) {
  if (room.disposed || es !== room.es) return;
  closeStream(room);
  setConnBadge(true);
  scheduleReconnect(room);
}

function scheduleReconnect(room) {
  clearTimeout(room.retryTimer);
  const delay = Math.min(RECONNECT_DELAY_MS * 2 ** room.retries, MAX_RECONNECT_DELAY_MS);
  room.retries += 1;
  room.retryTimer = setTimeout(() => reconnect(room), delay);
}

async function reconnect(room) {
  clearTimeout(room.retryTimer);
  if (room.disposed) return;
  try {
    applySnapshot(room, await fetchMemberSnapshot(room));
    if (!room.disposed) connect(room);
  } catch (err) {
    if (err.code === 'room_not_found') return failRoom(room, 'closed');
    if (err.code === 'kicked') return failRoom(room, 'kicked');
    scheduleReconnect(room);
  }
}

// A public view for someone holding a session means the token no longer belongs to the room.
async function fetchMemberSnapshot(room) {
  const data = await api.getRoom(room.code, room.session.playerToken);
  if (!isMemberSnapshot(data)) throw new ApiError(401, 'kicked');
  return data;
}

/** Refetches the snapshot; used when the stream may have missed events (frozen phone, stale vote). */
export async function refreshRoom(room) {
  try {
    applySnapshot(room, await fetchMemberSnapshot(room));
  } catch (err) {
    if (err.code === 'room_not_found') failRoom(room, 'closed');
    else if (err.code === 'kicked') failRoom(room, 'kicked');
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

// The card leaves (thrown, or shrunk if most voters had played it), the next game is painted into it while
// hidden over the identical card underneath, then it fades in. Snapshots arriving meanwhile are
// kept (room.busy) and rendered at the end.
async function animateClose(room) {
  room.busy = true;
  await leaveCard(room.state.lastResult);
  if (room.disposed) return void (room.busy = false);
  prepareNextCard();
  paint(room);
  await revealNextCard();
  room.busy = false;
  if (!room.disposed) renderPhase(room);
}

function leaveCard(result) {
  if (result.playedOut) {
    // Ranked apart as already played: no LIKE/NOPE, the toast (role=alert) also reaches screen readers.
    toast(`«${gameName(result.gameId)}» — la mayoría ya lo jugó`);
    return playedOut();
  }
  announceResult(result);
  return flyOut(result.likes > result.nopes ? 'right' : 'left');
}

export function renderPhase(room) {
  if (!room.busy) paint(room);
}

function paint(room) {
  if (room.disposed || !room.state) return;
  const { phase, index, deck } = room.state;
  $('progress').hidden = phase !== 'voting';
  $('progress').textContent = `${Math.min(index + 1, deck.length)} / ${deck.length}`;
  if (phase !== 'voting') resetMedia();
  // An early finish undone reopens the same card: it must render (and load its trailer) again.
  if (phase !== 'voting') forgetRenderedGame();
  syncRankingSheet(room.state);
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
