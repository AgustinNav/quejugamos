// "Ya lo jugamos" memory on the host's device. There are no accounts, so the games a room skipped as
// already played live in this browser's localStorage and are left out of the next rooms it creates.
// Storage can throw (private mode, blocked cookies): every access is guarded and failures only
// mean the memory is not kept.
import { $ } from './dom.js';
import { getGame } from './catalog.js';

const KEY = 'quejugamos:played';
const MAX_STORED = 500;
// Server cap for filters.excludeGameIds (docs/API.md).
const MAX_EXCLUDED = 200;

function loadPlayed() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(list) ? list.filter((id) => typeof id === 'string') : [];
  } catch (err) {
    console.warn('[played] could not read the played list:', err);
    return [];
  }
}

function savePlayed(list) {
  try {
    if (list.length) localStorage.setItem(KEY, JSON.stringify(list.slice(-MAX_STORED)));
    else localStorage.removeItem(KEY);
  } catch (err) {
    console.warn('[played] could not save the played list:', err);
  }
}

// Most recent last, so the cap drops the oldest entries first.
function updatePlayed(added, removed) {
  const drop = new Set([...added, ...removed]);
  savePlayed([...loadPlayed().filter((id) => !drop.has(id)), ...added]);
}

/**
 * Ids to send as filters.excludeGameIds: only games still in the catalog (the server rejects unknown
 * ids with 400), capped to the most recent ones the server accepts.
 */
export function excludedGameIds() {
  return loadPlayed().filter((id) => getGame(id)).slice(-MAX_EXCLUDED);
}

/**
 * Host only: remembers every card this room skipped as played, whoever tapped it. A skip the host
 * undid is forgotten again (it was a mistake, the card is back in play).
 */
export function syncPlayed(room) {
  if (!room.isHost || !room.state) return;
  const played = Object.values(room.state.results || {}).filter((r) => r.played).map((r) => r.gameId);
  const seen = room.playedSeen || new Set();
  const added = played.filter((id) => !seen.has(id));
  const removed = [...seen].filter((id) => !played.includes(id));
  room.playedSeen = new Set(played);
  if (added.length || removed.length) updatePlayed(added, removed);
}

/** Lobby (host): "N juegos ya jugados ocultos · Mostrar de nuevo", hidden when there are none. */
export function renderPlayedHint() {
  const count = excludedGameIds().length;
  $('playedHint').hidden = count === 0;
  $('playedHintText').textContent = count === 1 ? '1 juego ya jugado oculto' : `${count} juegos ya jugados ocultos`;
}

export function bindPlayedHint() {
  $('playedResetBtn').addEventListener('click', () => {
    if (!window.confirm('¿Mostrar de nuevo los juegos que ya jugaron? Van a volver a aparecer en las próximas salas.')) return;
    savePlayed([]);
    renderPlayedHint();
  });
}
