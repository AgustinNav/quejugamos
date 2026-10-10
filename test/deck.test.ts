import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDeck, parseFilters, priceFromDetails, shuffle } from '../src/deck.ts';
import type { CatalogGame } from '../src/deck.ts';
import { RoomError } from '../src/rooms.ts';
import { GAMES, PLATFORMS } from '../public/games.js';

const CATALOG: CatalogGame[] = [
  { id: 'pc-small', steamId: 1, players: [1, 4], platforms: ['PC'] },
  { id: 'console-big', players: [1, 10], platforms: ['PlayStation', 'Xbox'] },
  { id: 'cheap-all', steamId: 2, players: [1, 8], platforms: ['PC', 'Switch'] },
  { id: 'unknown-price', steamId: 3, players: [1, 8], platforms: ['PC'] },
];
const PRICES = new Map<string, number | null>([
  ['pc-small', 25], ['console-big', 0], ['cheap-all', 5], ['unknown-price', null],
]);
const identity = (max: number) => max - 1; // Fisher-Yates with j = i keeps the order.
const ids = (platforms: string[], maxPrice: number | null, fitsGroup: boolean, players: number) =>
  buildDeck(CATALOG, { platforms, maxPrice, fitsGroup }, players, PRICES, identity);

describe('buildDeck filters', () => {
  test('platforms: any overlap passes', () => {
    assert.deepEqual(ids(['Switch'], null, false, 1), ['cheap-all']);
    assert.deepEqual(ids(['Xbox', 'PC'], null, false, 1), ['pc-small', 'console-big', 'cheap-all', 'unknown-price']);
  });

  test('maxPrice: excludes more expensive, unknown price passes, null = no limit', () => {
    assert.deepEqual(ids(['PC'], 10, false, 1), ['cheap-all', 'unknown-price']);
    assert.deepEqual(ids(['PC'], 0, false, 1), ['unknown-price']);
    assert.deepEqual(ids(['PC'], null, false, 1), ['pc-small', 'cheap-all', 'unknown-price']);
  });

  test('fitsGroup: game max players must be >= player count', () => {
    assert.deepEqual(ids(['PC', 'Xbox'], null, true, 5), ['console-big', 'cheap-all', 'unknown-price']);
    assert.deepEqual(ids(['PC', 'Xbox'], null, true, 9), ['console-big']);
    assert.equal(ids(['PC', 'Xbox'], null, false, 9).length, 4);
  });

  test('empty platforms yields an empty deck', () => {
    assert.deepEqual(ids([], null, false, 1), []);
  });

  test('works against the real catalog', () => {
    const prices = new Map<string, number | null>();
    const deck = buildDeck(GAMES, { platforms: [...PLATFORMS], maxPrice: null, fitsGroup: false }, 2, prices, () => 0);
    assert.equal(deck.length, GAMES.length);
  });
});

describe('shuffle', () => {
  test('keeps every item and does not mutate the input', () => {
    const input = Array.from({ length: 50 }, (_, i) => i);
    const out = shuffle(input, (max) => Math.floor(Math.random() * max));
    assert.deepEqual([...out].sort((a, b) => a - b), input);
    assert.deepEqual(input, Array.from({ length: 50 }, (_, i) => i));
  });

  test('is deterministic for an injected random source', () => {
    assert.deepEqual(shuffle(['a', 'b', 'c'], () => 0), ['b', 'c', 'a']);
  });
});

describe('parseFilters', () => {
  const ok = { platforms: ['PC', 'PC', 'Switch'], maxPrice: 20, fitsGroup: true };

  test('accepts and dedupes valid filters', () => {
    assert.deepEqual(parseFilters(ok, PLATFORMS), { platforms: ['PC', 'Switch'], maxPrice: 20, fitsGroup: true });
    assert.equal(parseFilters({ ...ok, maxPrice: null }, PLATFORMS).maxPrice, null);
  });

  const bad: unknown[] = [
    null, [], 'x', {},
    { ...ok, platforms: 'PC' }, { ...ok, platforms: ['Amiga'] }, { ...ok, platforms: [1] },
    { ...ok, maxPrice: -1 }, { ...ok, maxPrice: '20' }, { ...ok, maxPrice: Infinity }, { ...ok, maxPrice: undefined },
    { ...ok, fitsGroup: 'yes' }, { ...ok, platforms: Array(100).fill('PC') },
  ];
  for (const input of bad) {
    test(`rejects ${JSON.stringify(input)?.slice(0, 60)}`, () => {
      assert.throws(() => parseFilters(input, PLATFORMS), (err: unknown) =>
        err instanceof RoomError && err.status === 400 && err.code === 'invalid_filters');
    });
  }
});

describe('priceFromDetails', () => {
  test('free, priced, label and unknown', () => {
    assert.equal(priceFromDetails({ id: 'x', players: [1, 1], platforms: [] }, { isFree: true, price: null }), 0);
    assert.equal(priceFromDetails({ id: 'x', players: [1, 1], platforms: [] }, { isFree: false, price: { final: 1999 } }), 19.99);
    assert.equal(priceFromDetails({ id: 'x', players: [1, 1], platforms: [], priceLabel: 'Gratis' }, null), 0);
    assert.equal(priceFromDetails({ id: 'x', players: [1, 1], platforms: [] }, null), null);
  });
});
