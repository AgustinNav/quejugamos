// Steam store client: allowlisted app ids, 6 h cache persisted to disk, in-flight dedupe.
import fs from 'node:fs';
import { priceFromDetails } from './deck.ts';
import type { CatalogGame } from './deck.ts';
import type { Logger } from './log.ts';
import { UpstreamQueue } from './upstream-queue.ts';
import type { Priority } from './upstream-queue.ts';

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
  queue?: UpstreamQueue;
};

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 8000;
// Negative cache: a failing app is not retried upstream for this long (callers get stale or 502).
const FAILURE_TTL_MS = 120_000;
// After Steam answers 429, nobody calls it for this long: hammering a rate limit only extends it.
const RATE_LIMIT_BACKOFF_MS = 60_000;
// ~5 requests/s at most: the whole catalog warms in ~25 s without tripping Steam's undocumented limit.
const MAX_CONCURRENT_REQUESTS = 3;
const MIN_REQUEST_INTERVAL_MS = 200;

export type Movie = { name: string; poster: string | null; hls: string | null; mp4: string | null };

// Caps keep the payload small: the gallery is opened on phones over mobile data.
const MAX_MOVIES = 6;
const MAX_SCREENSHOTS = 12;

function toMovie(raw: any): Movie | null {
  const hls = raw?.hls_h264 || null;
  const mp4 = raw?.mp4?.max || raw?.mp4?.['480'] || null;
  if (!hls && !mp4) return null; // nothing playable
  return { name: String(raw.name ?? ''), poster: raw.thumbnail || null, hls, mp4 };
}

/** Highlighted trailers first (Steam's own pick), then the rest, in Steam's order. */
function pickMovies(raw: unknown): Movie[] {
  if (!Array.isArray(raw)) return [];
  const ordered = [...raw.filter((m) => m?.highlight), ...raw.filter((m) => !m?.highlight)];
  return ordered.map(toMovie).filter((m): m is Movie => m !== null).slice(0, MAX_MOVIES);
}

function pickScreenshots(raw: unknown): { full: string; thumb: string }[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((s) => typeof s?.path_full === 'string')
    .slice(0, MAX_SCREENSHOTS)
    .map((s) => ({ full: s.path_full, thumb: typeof s.path_thumbnail === 'string' ? s.path_thumbnail : s.path_full }));
}

function toGameDetails(data: any): GameDetails {
  const movies = pickMovies(data.movies);
  const shots = pickScreenshots(data.screenshots);
  return {
    name: data.name,
    isFree: data.is_free,
    price: data.price_overview || null,
    shortDescription: data.short_description,
    header: data.header_image,
    screenshots: shots.map((s) => s.full),
    screenshotThumbs: shots.map((s) => s.thumb),
    movie: movies[0] ?? null,
    movies,
    genres: (data.genres || []).map((g: any) => g.description),
    categories: (data.categories || []).map((c: any) => c.description),
    reviews: data.recommendations?.total || null,
    metacritic: data.metacritic?.score || null,
    releaseDate: data.release_date?.date || null,
  };
}

/** Entries cached by older versions lack the gallery fields: they count as a miss (still usable as stale). */
function hasCurrentShape(details: GameDetails | undefined): boolean {
  return Array.isArray(details?.movies) && Array.isArray(details?.screenshotThumbs);
}

export class SteamClient {
  private readonly options: SteamClientOptions;
  private readonly allowed: Set<string>;
  private readonly cache: Record<string, CacheEntry>;
  private readonly inFlight = new Map<string, Promise<GameDetails>>();
  private readonly failedAt = new Map<string, number>();
  private blockedUntil = 0;
  private readonly queue: UpstreamQueue;

  constructor(options: SteamClientOptions) {
    this.options = options;
    this.allowed = new Set(options.games.filter((g) => g.steamId).map((g) => String(g.steamId)));
    this.cache = this.loadCache();
    // Spacing is wall-clock time (real timers), so the queue never uses the injectable business clock.
    this.queue = options.queue ?? new UpstreamQueue({
      maxConcurrent: MAX_CONCURRENT_REQUESTS, minIntervalMs: MIN_REQUEST_INTERVAL_MS,
    });
  }

  isAllowed(appId: string): boolean {
    return this.allowed.has(appId);
  }

  staleDetails(appId: string): GameDetails | null {
    return this.cache[appId]?.details ?? null;
  }

  /** Concurrent misses for the same app share one upstream call; an interactive caller promotes it. */
  getDetails(appId: string, priority: Priority = 'interactive'): Promise<GameDetails> {
    const cached = this.cache[appId];
    if (cached && this.now() - cached.at < CACHE_TTL_MS && hasCurrentShape(cached.details)) return Promise.resolve(cached.details);
    let pending = this.inFlight.get(appId);
    if (pending && priority === 'interactive') this.queue.promote(appId);
    if (!pending && this.inBackoff(appId)) return Promise.reject(new Error('Steam backoff: not retrying yet'));
    if (!pending) {
      pending = this.request(appId, priority).finally(() => this.inFlight.delete(appId));
      this.inFlight.set(appId, pending);
    }
    return pending;
  }

  /** Fills the cache in the background (after a deploy or a Render spin-up the cache is empty). */
  warmCache(): void {
    for (const game of this.options.games) {
      if (game.steamId) this.getDetails(String(game.steamId), 'background').catch(() => {});
    }
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
      const details = await this.getDetails(String(game.steamId), 'background').catch(() => null);
      if (details) prices.set(game.id, priceFromDetails(game, details));
    });
    await Promise.race([Promise.allSettled(lookups), delay(timeoutMs)]);
    return new Map(prices);
  }

  /** Recent failure for this app, or a global pause after Steam rate-limited us. */
  private inBackoff(appId: string): boolean {
    const now = this.now();
    if (now < this.blockedUntil) return true;
    const failed = this.failedAt.get(appId);
    if (failed === undefined) return false;
    if (now - failed < FAILURE_TTL_MS) return true;
    this.failedAt.delete(appId);
    return false;
  }

  private cachedOrStale(game: CatalogGame): GameDetails | null {
    return game.steamId ? this.staleDetails(String(game.steamId)) : null;
  }

  private async request(appId: string, priority: Priority): Promise<GameDetails> {
    try {
      const details = await this.queue.run(appId, priority, () => this.fetchDetails(appId));
      this.failedAt.delete(appId);
      return details;
    } catch (err) {
      this.failedAt.set(appId, this.now());
      throw err;
    }
  }

  private async fetchDetails(appId: string): Promise<GameDetails> {
    const url = `https://store.steampowered.com/api/appdetails?appids=${appId}&cc=${this.options.country}&l=spanish`;
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (res.status === 429) this.blockedUntil = this.now() + RATE_LIMIT_BACKOFF_MS;
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
