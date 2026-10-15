// Pure model + text for exporting the final ranking (PNG poster and plain text). No DOM, so
// node:test covers it (test/ranking-export.test.ts). Numbers come from the server's frozen
// `results`; `votes` only supplies the names of the likers still in the room.
import { closedResults, playedOutResults, rankedResults } from './ranking-data.js';

export const SITE = 'quejugamos.com.ar';
export const MAX_ITEMS = 10;
const MAX_NAMES = 4;

const firstName = (name) => String(name ?? '').trim().split(/\s+/)[0] || '';

/** Default vote order, same as the results screen: likes desc, nopes asc, cheaper first, deck order last. */
export function rankedByVotes(state, priceOf = () => null) {
  const rows = rankedResults(state).map((result, index) => ({ result, index }));
  rows.sort((a, b) => b.result.likes - a.result.likes || a.result.nopes - b.result.nopes
    || (priceOf(a.result.gameId) ?? 99) - (priceOf(b.result.gameId) ?? 99) || a.index - b.index);
  return rows.map((r) => r.result);
}

/**
 * Everything the poster and the text need. `nameOf(gameId)` resolves a catalog name (falsy = unknown
 * game, skipped); `priceOf(gameId)` is only the ranking tie-break.
 * @param {any} state
 * @param {{ nameOf: (gameId: string) => string | undefined, priceOf?: (gameId: string) => number | null, now?: Date, max?: number }} options
 */
export function buildExport(state, { nameOf, priceOf = () => null, now = new Date(), max = MAX_ITEMS } = {}) {
  const items = rankedByVotes(state, priceOf)
    .filter((r) => nameOf(r.gameId))
    .map((r, i) => ({
      position: i + 1,
      name: nameOf(r.gameId),
      likes: r.likes,
      match: r.match === true,
      likers: state.players.filter((p) => state.votes?.[r.gameId]?.[p.id] === 'like').map((p) => firstName(p.name)),
    }));
  return {
    code: state.code,
    date: formatDate(now),
    players: state.players.map((p) => firstName(p.name)).filter(Boolean),
    total: items.length,
    items: items.slice(0, max),
    played: playedOutResults(state).map((r) => nameOf(r.gameId)).filter(Boolean),
    hasResults: closedResults(state).length > 0,
  };
}

/** dd/mm/yyyy, built by hand so it does not depend on the runtime's locale data. */
export function formatDate(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`;
}

export function likersLabel(likers) {
  if (!likers.length) return '';
  const shown = likers.slice(0, MAX_NAMES).join(', ');
  return likers.length > MAX_NAMES ? `${shown}…` : shown;
}

/** Plain-text ranking for the clipboard, e.g. "1. 💘 PEAK — 4 👍 (Agus, Juli…)". */
export function formatRankingText(model) {
  const lines = [`¿Qué Jugamos? — ranking del ${model.date}`];
  if (model.players.length) lines.push(`Jugaron: ${model.players.join(', ')}`);
  lines.push('');
  if (!model.items.length) lines.push('No se llegó a votar ningún juego.');
  for (const item of model.items) {
    const who = likersLabel(item.likers);
    lines.push(`${item.position}. ${item.match ? '💘 ' : ''}${item.name} — ${item.likes} 👍${who ? ` (${who})` : ''}`);
  }
  if (model.total > model.items.length) lines.push(`… y ${model.total - model.items.length} más`);
  if (model.played.length) lines.push('', `Ya jugados: ${model.played.join(', ')}`);
  lines.push('', SITE);
  return lines.join('\n');
}
