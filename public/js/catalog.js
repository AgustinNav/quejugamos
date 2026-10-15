// Static catalog + lazily fetched Steam details (only the cards we are about to show).
import { GAMES, PLATFORMS } from '../games.js';
import { api } from './api.js';
import { esc } from './dom.js';

export { PLATFORMS };

const gamesById = new Map(GAMES.map((g) => [g.id, g]));
const details = new Map();
const inFlight = new Map();

export const getGame = (id) => gamesById.get(id);
export const getDetails = (id) => details.get(id);

// Resolves to the details or null; failures are logged and never retried in a tight loop.
export function loadDetails(gameId) {
  const game = gamesById.get(gameId);
  if (!game?.steamId) return Promise.resolve(null);
  if (details.has(gameId)) return Promise.resolve(details.get(gameId));
  if (!inFlight.has(gameId)) inFlight.set(gameId, fetchDetails(game));
  return inFlight.get(gameId);
}

async function fetchDetails(game) {
  try {
    const data = await api.steam(game.steamId);
    details.set(game.id, data);
    return data;
  } catch (err) {
    console.warn(`[catalog] no Steam data for ${game.name}:`, err.code || err);
    return null;
  } finally {
    inFlight.delete(game.id);
  }
}

// Runs loadDetails over a list with a small concurrency cap.
export async function loadMany(gameIds, concurrency = 4) {
  const queue = [...gameIds];
  const worker = async () => {
    while (queue.length) await loadDetails(queue.shift());
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
}

export function priceUsd(game) {
  const d = details.get(game.id);
  if (d?.isFree || game.priceLabel === 'Gratis') return 0;
  if (d?.price) return d.price.final / 100;
  return null;
}

// Returns markup built only from numbers/escaped text.
export function priceInfo(game) {
  const d = details.get(game.id);
  if (d?.isFree || game.priceLabel === 'Gratis') return { html: 'Gratis', free: true };
  if (!d?.price) return { html: esc(game.priceLabel || 'Ver precio'), free: false };
  const { initial, final, discount_percent: off, currency } = d.price;
  const fmt = (cents) => `${currency === 'USD' ? 'US$' : esc(currency) + ' '}${(cents / 100).toFixed(2)}`;
  if (off > 0) return { html: `<span class="old">${fmt(initial)}</span>${fmt(final)}<span class="off">-${Number(off)}%</span>`, free: false };
  return { html: fmt(final), free: false };
}

export function playersLabel(game) {
  const [min, max] = game.players;
  return `👥 ${min === max ? min : `${min}–${max}`} jugadores`;
}

export function storeUrl(game) {
  return game.steamId ? `https://store.steampowered.com/app/${game.steamId}` : game.storeUrl;
}

/** [label, url, kind, icon]: `kind` picks the button style (primary store CTA vs secondary helpers). */
export function storeLinks(game) {
  const q = encodeURIComponent(game.name);
  const links = [];
  if (game.steamId) links.push(['Steam', storeUrl(game), 'store steam', '🛒']);
  if (game.storeUrl) links.push(['Tienda oficial', game.storeUrl, 'store', '🛒']);
  links.push(['Gameplay', `https://www.youtube.com/results?search_query=${q}+gameplay+coop`, 'gameplay', '▶']);
  links.push(['Precios', `https://isthereanydeal.com/search/?q=${q}`, 'prices', '💸']);
  return links;
}

/** What the deal badge shows: `{ free: true }`, `{ off: 75 }` or null. Numbers only, never markup. */
export function dealInfo(game) {
  const d = details.get(game.id);
  if (d?.isFree || game.priceLabel === 'Gratis') return { free: true };
  const off = Number(d?.price?.discount_percent);
  return off > 0 && off <= 100 ? { off: Math.round(off) } : null;
}

/** Plain-text requirement lines, or null when the card has nothing to show (old cache, console-only game). */
export function pcRequirements(game) {
  const reqs = details.get(game.id)?.pcRequirements;
  if (!reqs || typeof reqs !== 'object') return null;
  const clean = (lines) => (Array.isArray(lines) ? lines.filter((l) => typeof l === 'string' && l).slice(0, 12) : []);
  const result = { minimum: clean(reqs.minimum), recommended: clean(reqs.recommended) };
  return result.minimum.length || result.recommended.length ? result : null;
}
