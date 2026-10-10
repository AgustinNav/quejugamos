// Deck building: validate filters, filter the catalog and shuffle it. Pure functions.
import { RoomError } from './rooms.ts';
import type { Filters } from './rooms.ts';

export type CatalogGame = {
  id: string;
  steamId?: number;
  players: number[];
  platforms: string[];
  priceLabel?: string;
};

/** gameId -> price in USD, or null when unknown. */
export type PriceMap = ReadonlyMap<string, number | null>;

const MAX_PRICE_LIMIT = 10_000;

function invalidFilters(message: string): RoomError {
  return new RoomError(400, 'invalid_filters', message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePlatforms(value: unknown, known: readonly string[]): string[] {
  if (!Array.isArray(value) || value.length > known.length * 2) throw invalidFilters('platforms must be an array of strings');
  for (const p of value) {
    if (typeof p !== 'string' || !known.includes(p)) throw invalidFilters(`Unknown platform. Valid: ${known.join(', ')}`);
  }
  return [...new Set(value as string[])];
}

function parseMaxPrice(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_PRICE_LIMIT) {
    throw invalidFilters('maxPrice must be null or a number between 0 and 10000');
  }
  return value;
}

/** Validates untrusted filters input. Throws RoomError(400, invalid_filters). */
export function parseFilters(input: unknown, knownPlatforms: readonly string[]): Filters {
  if (!isPlainObject(input)) throw invalidFilters('filters must be an object');
  const platforms = parsePlatforms(input.platforms, knownPlatforms);
  const maxPrice = parseMaxPrice(input.maxPrice);
  if (typeof input.fitsGroup !== 'boolean') throw invalidFilters('fitsGroup must be a boolean');
  return { platforms, maxPrice, fitsGroup: input.fitsGroup };
}

/** Same rule as the v1 client: free games cost 0, unknown prices are null (and pass the filter). */
export function priceFromDetails(game: CatalogGame, details: { isFree?: boolean; price?: { final: number } | null } | null): number | null {
  if (details?.isFree || game.priceLabel === 'Gratis') return 0;
  if (details?.price && typeof details.price.final === 'number') return details.price.final / 100;
  return null;
}

export function matchesFilters(game: CatalogGame, filters: Filters, playerCount: number, prices: PriceMap): boolean {
  if (!game.platforms.some((p) => filters.platforms.includes(p))) return false;
  if (filters.fitsGroup && game.players[1] < playerCount) return false;
  const price = prices.get(game.id) ?? null;
  return filters.maxPrice === null || price === null || price <= filters.maxPrice;
}

/** Fisher-Yates over a copy; randomInt(n) must return an integer in [0, n). */
export function shuffle<T>(items: readonly T[], randomInt: (maxExclusive: number) => number): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export function buildDeck(
  games: readonly CatalogGame[],
  filters: Filters,
  playerCount: number,
  prices: PriceMap,
  randomInt: (maxExclusive: number) => number,
): string[] {
  const ids = games.filter((g) => matchesFilters(g, filters, playerCount, prices)).map((g) => g.id);
  return shuffle(ids, randomInt);
}
