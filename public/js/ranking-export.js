// Pure model + text for exporting the final ranking (PNG poster and plain text). No DOM, so
// node:test covers it (test/ranking-export.test.ts). Numbers come from the server's frozen
// `results`; `votes` only supplies the names of the likers still in the room. Rankings get posted
// publicly, so player names are left out unless the caller opts in with `includeNames`.
import { closedResults, playedOutResults, rankedResults, rankScore } from './ranking-data.js';

export const SITE = 'quejugamos.com.ar';
export const MAX_ITEMS = 10;
const MAX_NAMES = 4;

const firstName = (name) => String(name ?? '').trim().split(/\s+/)[0] || '';

/** Default vote order, same as the results screen: score (SuperLike counts double) desc, nopes asc, cheaper first, deck order last. */
export function rankedByVotes(state, priceOf = () => null) {
  const rows = rankedResults(state).map((result, index) => ({ result, index }));
  rows.sort((a, b) => rankScore(b.result) - rankScore(a.result) || a.result.nopes - b.result.nopes
    || (priceOf(a.result.gameId) ?? 99) - (priceOf(b.result.gameId) ?? 99) || a.index - b.index);
  return rows.map((r) => r.result);
}

/**
 * Everything the poster and the text need. `nameOf(gameId)` resolves a catalog name (falsy = unknown
 * game, skipped); `priceOf(gameId)` is only the ranking tie-break. The SuperLike count is always
 * there; without `includeNames`, `players`, every `likers` and every `superlikers` are empty, which makes both renderers drop those lines.
 * @param {any} state
 * @param {{ nameOf: (gameId: string) => string | undefined, priceOf?: (gameId: string) => number | null, now?: Date, max?: number, includeNames?: boolean }} options
 */
export function buildExport(state, { nameOf, priceOf = () => null, now = new Date(), max = MAX_ITEMS, includeNames = false } = {}) {
  const items = rankedByVotes(state, priceOf)
    .filter((r) => nameOf(r.gameId))
    .map((r, i) => ({
      position: i + 1,
      name: nameOf(r.gameId),
      likes: r.likes,
      superlikes: r.superlikes ?? 0,
      match: r.match === true,
      likers: !includeNames ? [] : state.players.filter((p) => state.votes?.[r.gameId]?.[p.id] === 'like').map((p) => firstName(p.name)),
      superlikers: !includeNames ? [] : state.players.filter((p) => (r.superlikedBy ?? []).includes(p.id)).map((p) => firstName(p.name)),
    }));
  return {
    code: state.code,
    date: formatDate(now),
    players: !includeNames ? [] : state.players.map((p) => firstName(p.name)).filter(Boolean),
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

/** "Agus, Juli · ⭐ Pedro": who liked it, then who spent a SuperLike on it (names only when opted in). */
export function namesLabel(item) {
  const likers = likersLabel(item.likers);
  const superlikers = likersLabel(item.superlikers ?? []);
  return [likers, superlikers && `⭐ ${superlikers}`].filter(Boolean).join(' · ');
}

/** "4 👍 · ⭐ 1": the likes total (SuperLikes included) and, when there are any, how many were SuperLikes. */
export const scoreLabel = (item) => `${item.likes} 👍${item.superlikes ? ` · ⭐ ${item.superlikes}` : ''}`;

/** Plain-text ranking for the clipboard, e.g. "1. 💘 PEAK — 4 👍 · ⭐ 1 (Agus, Juli…)". */
export function formatRankingText(model) {
  const lines = [`¿Qué Jugamos? — ranking del ${model.date}`];
  if (model.players.length) lines.push(`Jugaron: ${model.players.join(', ')}`);
  lines.push('');
  if (!model.items.length) lines.push('No se llegó a votar ningún juego.');
  for (const item of model.items) {
    const who = namesLabel(item);
    lines.push(`${item.position}. ${item.match ? '💘 ' : ''}${item.name} — ${scoreLabel(item)}${who ? ` (${who})` : ''}`);
  }
  if (model.total > model.items.length) lines.push(`… y ${model.total - model.items.length} más`);
  if (model.played.length) lines.push('', `Ya jugados: ${model.played.join(', ')}`);
  lines.push('', SITE);
  return lines.join('\n');
}
