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
const ids = (platforms: string[], maxPrice: number | null, fitsGroup: boolean, players: number, playerCount: number | null = null) =>
  buildDeck(CATALOG, { platforms, maxPrice, fitsGroup, playerCount }, players, PRICES, identity);
const SIZED: CatalogGame[] = [
  { id: 'duo', players: [2, 2], platforms: ['PC'] },
  { id: 'solo-to-four', players: [1, 4], platforms: ['PC'] },
  { id: 'party', players: [4, 15], platforms: ['PC'] },
  { id: 'huge', players: [1, 32], platforms: ['PC'] },
];
const sized = (playerCount: number | null, fitsGroup: boolean, roomPlayers: number) =>
  buildDeck(SIZED, { platforms: ['PC'], maxPrice: null, fitsGroup, playerCount }, roomPlayers, new Map(), identity);

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

  test('playerCount: the game must support exactly that many (min <= N <= max)', () => {
    assert.deepEqual(sized(2, false, 1), ['duo', 'solo-to-four', 'huge']);
    assert.deepEqual(sized(3, false, 1), ['solo-to-four', 'huge']);
    assert.deepEqual(sized(4, false, 1), ['solo-to-four', 'party', 'huge']);
    assert.deepEqual(sized(5, false, 1), ['party', 'huge']);
    assert.deepEqual(sized(1, false, 1), ['solo-to-four', 'huge']);
  });

  test('playerCount wins over fitsGroup and the room size', () => {
    // Room of 12 with fitsGroup would keep only party+huge; an explicit 2 ignores both.
    assert.deepEqual(sized(2, true, 12), ['duo', 'solo-to-four', 'huge']);
  });

  test('playerCount null keeps the fitsGroup behavior (max >= room size, min ignored)', () => {
    assert.deepEqual(sized(null, true, 3), ['solo-to-four', 'party', 'huge']);
    assert.deepEqual(sized(null, false, 30), ['duo', 'solo-to-four', 'party', 'huge']);
  });

  test('empty platforms yields an empty deck', () => {
    assert.deepEqual(ids([], null, false, 1), []);
  });

  test('works against the real catalog', () => {
    const prices = new Map<string, number | null>();
    const deck = buildDeck(GAMES, { platforms: [...PLATFORMS], maxPrice: null, fitsGroup: false, playerCount: null }, 2, prices, () => 0);
    assert.equal(deck.length, GAMES.length);
  });
});

describe('catalog integrity', () => {
  test('ids, steamIds and names are unique; players is a valid [min, max]', () => {
    const unique = (values: unknown[]) => new Set(values).size === values.length;
    assert.ok(unique(GAMES.map((g) => g.id)), 'duplicate id');
    assert.ok(unique(GAMES.filter((g) => g.steamId).map((g) => g.steamId)), 'duplicate steamId');
    assert.ok(unique(GAMES.map((g) => g.name.toLowerCase())), 'duplicate name');
    for (const g of GAMES) {
      assert.match(g.id, /^[a-z0-9]+(-[a-z0-9]+)*$/, g.id);
      const [min, max] = g.players;
      assert.ok(Number.isInteger(min) && Number.isInteger(max) && min >= 1 && min <= max, g.id);
      assert.ok(g.platforms.length > 0 && g.platforms.every((p) => PLATFORMS.includes(p)), g.id);
      assert.ok(g.steamId || (g.storeUrl && g.priceLabel), `${g.id}: non-Steam games need storeUrl + priceLabel`);
      assert.ok(!/tinder/i.test(g.pitch), g.id);
    }
  });

  test('every player-count option leaves a real deck on PC', () => {
    for (const playerCount of [2, 3, 4, 5]) {
      const deck = buildDeck(GAMES, { platforms: ['PC'], maxPrice: null, fitsGroup: true, playerCount }, 1, new Map(), () => 0);
      assert.ok(deck.length >= 15, `playerCount ${playerCount}: ${deck.length}`);
    }
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
  const { fitsGroup: _legacy, ...modern } = ok; // a playerCount client may omit fitsGroup

  test('accepts and dedupes valid filters', () => {
    assert.deepEqual(parseFilters(ok, PLATFORMS), { platforms: ['PC', 'Switch'], maxPrice: 20, fitsGroup: true, playerCount: null });
    assert.equal(parseFilters({ ...ok, maxPrice: null }, PLATFORMS).maxPrice, null);
  });

  test('playerCount: integer 1-32 or null; with it, fitsGroup is optional (defaults to true)', () => {
    assert.deepEqual(parseFilters({ ...modern, playerCount: 2 }, PLATFORMS), { platforms: ['PC', 'Switch'], maxPrice: 20, fitsGroup: true, playerCount: 2 });
    assert.equal(parseFilters({ ...modern, playerCount: null }, PLATFORMS).fitsGroup, true);
    assert.equal(parseFilters({ ...modern, playerCount: 1 }, PLATFORMS).playerCount, 1);
    assert.equal(parseFilters({ ...modern, playerCount: 32 }, PLATFORMS).playerCount, 32);
    assert.equal(parseFilters({ ...ok, fitsGroup: false, playerCount: null }, PLATFORMS).fitsGroup, false);
  });

  const bad: unknown[] = [
    null, [], 'x', {},
    { ...ok, platforms: 'PC' }, { ...ok, platforms: ['Amiga'] }, { ...ok, platforms: [1] },
    { ...ok, maxPrice: -1 }, { ...ok, maxPrice: '20' }, { ...ok, maxPrice: Infinity }, { ...ok, maxPrice: undefined },
    { ...ok, fitsGroup: 'yes' }, { ...ok, platforms: Array(100).fill('PC') },
    modern, { ...modern, fitsGroup: 'yes', playerCount: 2 },
    { ...ok, playerCount: 0 }, { ...ok, playerCount: 33 }, { ...ok, playerCount: 2.5 }, { ...ok, playerCount: '2' },
    { ...ok, playerCount: -1 }, { ...ok, playerCount: true }, { ...ok, playerCount: [2] }, { ...ok, playerCount: NaN },
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
