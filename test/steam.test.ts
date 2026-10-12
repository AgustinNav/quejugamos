import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SteamClient } from '../src/steam.ts';
import type { CatalogGame } from '../src/deck.ts';

const GAMES: CatalogGame[] = [
  { id: 'a', steamId: 100, players: [1, 4], platforms: ['PC'] },
  { id: 'b', steamId: 200, players: [1, 4], platforms: ['PC'] },
];
const HOUR = 60 * 60 * 1000;

type Reply = { status: number; success?: boolean } | 'throw';

/** Stub Steam: counts calls per app and answers with whatever `reply` currently says. */
function makeClient() {
  const clock = { t: 1_000_000 };
  const calls: string[] = [];
  const state: { reply: Reply; gate: Promise<void> | null } = { reply: { status: 200, success: true }, gate: null };
  const fetchImpl = (async (input: string | URL | Request) => {
    const appId = new URL(String(input)).searchParams.get('appids') ?? '';
    calls.push(appId);
    if (state.gate) await state.gate;
    const reply = state.reply;
    if (reply === 'throw') throw new Error('network down');
    const data = { name: `Game ${appId}`, is_free: false, price_overview: { final: 999 } };
    return new Response(JSON.stringify({ [appId]: { success: reply.success ?? true, data } }), { status: reply.status });
  }) as typeof fetch;
  const client = new SteamClient({ games: GAMES, country: 'ar', fetchImpl, cacheFile: null, now: () => clock.t, log: () => {} });
  return { client, clock, calls, state };
}

describe('SteamClient cache', () => {
  test('serves from cache within the 6 h TTL and refetches after it', async () => {
    const { client, clock, calls } = makeClient();
    assert.equal((await client.getDetails('100')).name, 'Game 100');
    clock.t += 6 * HOUR - 1;
    await client.getDetails('100');
    assert.deepEqual(calls, ['100']);
    clock.t += 1;
    await client.getDetails('100');
    assert.deepEqual(calls, ['100', '100']);
  });

  test('concurrent misses share one upstream call', async () => {
    const { client, calls, state } = makeClient();
    let open = () => {};
    state.gate = new Promise<void>((r) => { open = r; });
    const all = Promise.all([client.getDetails('100'), client.getDetails('100'), client.getDetails('100')]);
    open();
    const results = await all;
    assert.deepEqual(calls, ['100']);
    assert.ok(results.every((r) => r === results[0]));
  });

  test('keeps stale details available after the TTL when Steam fails', async () => {
    const { client, clock, state } = makeClient();
    await client.getDetails('100');
    clock.t += 7 * HOUR;
    state.reply = { status: 500 };
    await assert.rejects(client.getDetails('100'), /Steam responded 500/);
    assert.equal(client.staleDetails('100')?.name, 'Game 100');
    assert.equal(client.staleDetails('200'), null);
  });
});

describe('SteamClient negative cache (L8)', () => {
  test('a failure is not retried upstream for 120 s', async () => {
    const { client, clock, calls, state } = makeClient();
    state.reply = 'throw';
    await assert.rejects(client.getDetails('100'), /network down/);
    state.reply = { status: 200 };
    for (let i = 0; i < 50; i += 1) await assert.rejects(client.getDetails('100'), /backoff/);
    clock.t += 119_999;
    await assert.rejects(client.getDetails('100'), /backoff/);
    assert.deepEqual(calls, ['100']);
    clock.t += 1;
    assert.equal((await client.getDetails('100')).name, 'Game 100');
    assert.deepEqual(calls, ['100', '100']);
  });

  test('negative cache is per app; success clears it', async () => {
    const { client, clock, calls, state } = makeClient();
    state.reply = { status: 200, success: false };
    await assert.rejects(client.getDetails('100'), /no data/);
    state.reply = { status: 200 };
    assert.equal((await client.getDetails('200')).name, 'Game 200');
    clock.t += 120_000;
    await client.getDetails('100');
    clock.t += 7 * HOUR; // cache expired, previous failure must not linger
    await client.getDetails('100');
    assert.deepEqual(calls, ['100', '200', '100', '100']);
  });

  test('after an upstream 429, Steam is not called for any app for 60 s', async () => {
    const { client, clock, calls, state } = makeClient();
    state.reply = { status: 429 };
    await assert.rejects(client.getDetails('100'), /429/);
    state.reply = { status: 200 };
    await assert.rejects(client.getDetails('200'), /backoff/);
    const prices = await client.getCatalogPrices(100);
    assert.equal(prices.get('b'), null);
    assert.deepEqual(calls, ['100']);
    clock.t += 60_000;
    assert.equal((await client.getDetails('200')).name, 'Game 200');
    assert.deepEqual(calls, ['100', '200']);
  });
});

/** Client whose stub Steam always answers `data` for any app; returns the upstream call log too. */
function clientWithData(data: unknown, cacheFile: string | null = null) {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const appId = new URL(String(input)).searchParams.get('appids') ?? '';
    calls.push(appId);
    return new Response(JSON.stringify({ [appId]: { success: true, data } }), { status: 200 });
  }) as typeof fetch;
  const client = new SteamClient({ games: GAMES, country: 'ar', fetchImpl, cacheFile, log: () => {} });
  return { client, calls };
}

const movie = (id: number, extra: Record<string, unknown> = {}) => ({
  id, name: `Trailer ${id}`, thumbnail: `https://cdn.steamstatic.com/${id}.jpg`,
  hls_h264: `https://video.steamstatic.com/${id}/hls.m3u8`, ...extra,
});
const shot = (id: number) => ({ id, path_full: `https://cdn.steamstatic.com/full${id}.jpg`, path_thumbnail: `https://cdn.steamstatic.com/th${id}.jpg` });

describe('SteamClient details shape (gallery)', () => {
  test('returns up to 6 playable movies, highlighted first, and movie = the first one', async () => {
    const movies = [movie(1), movie(2, { highlight: true }), movie(3, { hls_h264: null }), ...[4, 5, 6, 7, 8].map((i) => movie(i))];
    movies.push(movie(9, { hls_h264: null, mp4: { 480: 'https://video.steamstatic.com/9.mp4' } }));
    const { client } = clientWithData({ name: 'X', movies });
    const details = await client.getDetails('100');
    const list = details.movies as { name: string; hls: string | null; mp4: string | null; poster: string }[];
    assert.deepEqual(list.map((m) => m.name), ['Trailer 2', 'Trailer 1', 'Trailer 4', 'Trailer 5', 'Trailer 6', 'Trailer 7']);
    assert.deepEqual(details.movie, list[0]);
    assert.deepEqual(Object.keys(list[0]).sort(), ['hls', 'mp4', 'name', 'poster']);
    assert.equal(list[0].poster, 'https://cdn.steamstatic.com/2.jpg');
  });

  test('a movie with only an mp4 is kept; without any source it is dropped', async () => {
    const { client } = clientWithData({ name: 'X', movies: [movie(1, { hls_h264: null }), movie(2, { hls_h264: null, mp4: { max: 'm.mp4' } })] });
    const details = await client.getDetails('100');
    assert.deepEqual(details.movies, [{ name: 'Trailer 2', poster: 'https://cdn.steamstatic.com/2.jpg', hls: null, mp4: 'm.mp4' }]);
  });

  test('returns up to 12 screenshots with matching thumbnails', async () => {
    const { client } = clientWithData({ name: 'X', screenshots: Array.from({ length: 20 }, (_, i) => shot(i)) });
    const details = await client.getDetails('100');
    const full = details.screenshots as string[];
    assert.equal(full.length, 12);
    assert.equal(full[11], 'https://cdn.steamstatic.com/full11.jpg');
    assert.deepEqual(details.screenshotThumbs, full.map((_, i) => `https://cdn.steamstatic.com/th${i}.jpg`));
  });

  test('missing or malformed media fields give empty lists and movie = null', async () => {
    const { client } = clientWithData({ name: 'X', movies: 'nope', screenshots: [null, { path_full: 7 }] });
    const details = await client.getDetails('100');
    assert.deepEqual(details.movies, []);
    assert.equal(details.movie, null);
    assert.deepEqual(details.screenshots, []);
    assert.deepEqual(details.screenshotThumbs, []);
  });
});

describe('SteamClient cache written by older versions', () => {
  test('a fresh entry without the gallery fields is refetched; the new one is served from cache', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qj-steam-'));
    const cacheFile = path.join(dir, 'cache.json');
    const legacy = { name: 'Old', movie: { name: 'T', poster: null, hls: 'h', mp4: null }, screenshots: ['a'] };
    fs.writeFileSync(cacheFile, JSON.stringify({ 100: { at: Date.now(), details: legacy } }));
    try {
      const { client: fresh, calls } = clientWithData({ name: 'New', movies: [movie(1)], screenshots: [shot(1)] }, cacheFile);
      assert.equal(fresh.staleDetails('100')?.name, 'Old');
      const details = await fresh.getDetails('100');
      assert.equal(details.name, 'New');
      assert.equal((details.movies as unknown[]).length, 1);
      await fresh.getDetails('100');
      assert.deepEqual(calls, ['100']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
