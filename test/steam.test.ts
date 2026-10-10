import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
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
