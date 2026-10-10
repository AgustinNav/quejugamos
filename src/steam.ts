// Steam store client: allowlisted app ids, 6 h cache persisted to disk, in-flight dedupe.
import fs from 'node:fs';
import { priceFromDetails } from './deck.ts';
import type { CatalogGame } from './deck.ts';
import type { Logger } from './log.ts';

export type GameDetails = {
  name: string;
  isFree: boolean;
  price: { final: number; initial?: number; currency?: string; discount_percent?: number } | null;
  [key: string]: unknown;
};

type CacheEntry = { at: number; details: GameDetails };

export type SteamClientOptions = {
  games: readonly CatalogGame[];
  country: string;
  fetchImpl?: typeof fetch;
  cacheFile?: string | null;
  now?: () => number;
  log: Logger;
};

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 8000;

function pickMovie(movies: any[] = []) {
  const movie = movies.find((m) => m.highlight) || movies[0];
  if (!movie) return null;
  return {
    name: movie.name,
    poster: movie.thumbnail,
    hls: movie.hls_h264 || null,
    mp4: movie.mp4?.max || movie.mp4?.['480'] || null,
  };
}

function toGameDetails(data: any): GameDetails {
  return {
    name: data.name,
    isFree: data.is_free,
    price: data.price_overview || null,
    shortDescription: data.short_description,
    header: data.header_image,
    screenshots: (data.screenshots || []).slice(0, 4).map((s: any) => s.path_full),
    movie: pickMovie(data.movies),
    genres: (data.genres || []).map((g: any) => g.description),
    categories: (data.categories || []).map((c: any) => c.description),
    reviews: data.recommendations?.total || null,
    metacritic: data.metacritic?.score || null,
    releaseDate: data.release_date?.date || null,
  };
}

export class SteamClient {
  private readonly options: SteamClientOptions;
  private readonly allowed: Set<string>;
  private readonly cache: Record<string, CacheEntry>;
  private readonly inFlight = new Map<string, Promise<GameDetails>>();

  constructor(options: SteamClientOptions) {
    this.options = options;
    this.allowed = new Set(options.games.filter((g) => g.steamId).map((g) => String(g.steamId)));
    this.cache = this.loadCache();
  }

  isAllowed(appId: string): boolean {
    return this.allowed.has(appId);
  }

  staleDetails(appId: string): GameDetails | null {
    return this.cache[appId]?.details ?? null;
  }

  /** Concurrent misses for the same app share one upstream call. */
  getDetails(appId: string): Promise<GameDetails> {
    const cached = this.cache[appId];
    if (cached && this.now() - cached.at < CACHE_TTL_MS) return Promise.resolve(cached.details);
    let pending = this.inFlight.get(appId);
    if (!pending) {
      pending = this.request(appId).finally(() => this.inFlight.delete(appId));
      this.inFlight.set(appId, pending);
    }
    return pending;
  }

  /**
   * USD price per catalog game. Bounded by timeoutMs so a slow Steam never blocks `start`:
   * whatever is missing stays null (unknown), which passes the price filter.
   */
  async getCatalogPrices(timeoutMs: number): Promise<Map<string, number | null>> {
    const prices = new Map<string, number | null>();
    for (const game of this.options.games) prices.set(game.id, priceFromDetails(game, this.cachedOrStale(game)));
    const steamGames = this.options.games.filter((g) => g.steamId);
    const lookups = steamGames.map(async (game) => {
      const details = await this.getDetails(String(game.steamId)).catch(() => null);
      if (details) prices.set(game.id, priceFromDetails(game, details));
    });
    await Promise.race([Promise.allSettled(lookups), delay(timeoutMs)]);
    return new Map(prices);
  }

  private cachedOrStale(game: CatalogGame): GameDetails | null {
    return game.steamId ? this.staleDetails(String(game.steamId)) : null;
  }

  private async request(appId: string): Promise<GameDetails> {
    const url = `https://store.steampowered.com/api/appdetails?appids=${appId}&cc=${this.options.country}&l=spanish`;
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`Steam responded ${res.status}`);
    const entry = ((await res.json()) as any)?.[appId];
    if (!entry?.success) throw new Error(`Steam has no data for app ${appId}`);
    const details = toGameDetails(entry.data);
    this.cache[appId] = { at: this.now(), details };
    this.persistCache();
    return details;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private loadCache(): Record<string, CacheEntry> {
    if (!this.options.cacheFile) return {};
    try {
      return JSON.parse(fs.readFileSync(this.options.cacheFile, 'utf8'));
    } catch {
      return {}; // Missing or corrupt cache: start empty.
    }
  }

  private persistCache(): void {
    if (!this.options.cacheFile) return;
    fs.writeFile(this.options.cacheFile, JSON.stringify(this.cache), (err) => {
      if (err) this.options.log('steam_cache_write_failed', { reason: err.message }, 'WARNING');
    });
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}
