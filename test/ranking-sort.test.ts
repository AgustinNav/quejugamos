import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { applyView, DEFAULT_PREFS, filterRows, hasActiveFilters, needsAllDetails, normalizePrefs, sortRows } from '../public/js/ranking-sort.js';

type Row = { id: string; name: string; match?: boolean; price: number | null; discount?: number; maxPlayers?: number };
const row = (id: string, o: Partial<Row> = {}): Row => ({ id, name: id, match: false, price: null, discount: 0, maxPlayers: 4, ...o });
const ids = (rows: Row[]) => rows.map((r) => r.id);

describe('ranking-sort', () => {
  const rows = [
    row('a', { price: 20, discount: 0, maxPlayers: 4, match: true }),
    row('b', { price: null, discount: 0, maxPlayers: 8 }),
    row('c', { price: 5, discount: 50, maxPlayers: 4 }),
    row('d', { price: 0, discount: 0, maxPlayers: 2 }),
    row('e', { price: null, discount: 0, maxPlayers: 8 }),
  ];

  test('votes keeps the incoming order', () => {
    assert.deepEqual(ids(sortRows(rows, 'votes')), ['a', 'b', 'c', 'd', 'e']);
  });

  test('cheap: ascending, unknown prices last, stable among equals', () => {
    assert.deepEqual(ids(sortRows(rows, 'cheap')), ['d', 'c', 'a', 'b', 'e']);
  });

  test('discount: highest first, ties keep vote order', () => {
    assert.deepEqual(ids(sortRows(rows, 'discount')), ['c', 'a', 'b', 'd', 'e']);
  });

  test('players: max players descending, stable', () => {
    assert.deepEqual(ids(sortRows(rows, 'players')), ['b', 'e', 'a', 'c', 'd']);
  });

  test('name: A-Z ignoring accents and case', () => {
    const named = [row('1', { name: 'zelda' }), row('2', { name: 'Álamo' }), row('3', { name: 'beta' })];
    assert.deepEqual(ids(sortRows(named, 'name')), ['2', '3', '1']);
  });

  test('unknown sort key falls back to vote order; input is not mutated', () => {
    const copy = [...rows];
    assert.deepEqual(ids(sortRows(rows, 'bogus')), ids(rows));
    assert.deepEqual(rows, copy);
  });

  test('filters combine with AND', () => {
    const f = { ...DEFAULT_PREFS };
    assert.deepEqual(ids(filterRows(rows, { ...f, match: true })), ['a']);
    assert.deepEqual(ids(filterRows(rows, { ...f, sale: true })), ['c']);
    assert.deepEqual(ids(filterRows(rows, { ...f, free: true })), ['d']);
    assert.deepEqual(ids(filterRows(rows, { ...f, match: true, sale: true })), []);
    assert.deepEqual(ids(filterRows(rows, f)), ['a', 'b', 'c', 'd', 'e']);
  });

  test('free requires a known price of exactly 0 (unknown is not free)', () => {
    assert.deepEqual(ids(filterRows([row('x', { price: null }), row('y', { price: 0 })], { ...DEFAULT_PREFS, free: true })), ['y']);
  });

  test('applyView filters then sorts', () => {
    const view = applyView(rows, { sort: 'cheap', match: false, sale: false, free: false });
    assert.deepEqual(ids(view), ['d', 'c', 'a', 'b', 'e']);
    const sale = applyView([...rows, row('f', { price: 9, discount: 10 })], { sort: 'cheap', match: false, sale: true, free: false });
    assert.deepEqual(ids(sale), ['c', 'f']);
  });

  test('normalizePrefs rejects garbage and keeps valid values', () => {
    assert.deepEqual(normalizePrefs(null), DEFAULT_PREFS);
    assert.deepEqual(normalizePrefs('x'), DEFAULT_PREFS);
    assert.deepEqual(normalizePrefs({ sort: 'evil', match: 'yes', sale: 1 }), DEFAULT_PREFS);
    assert.deepEqual(normalizePrefs({ sort: 'name', match: true }), { sort: 'name', match: true, sale: false, free: false });
  });

  test('hasActiveFilters / needsAllDetails', () => {
    assert.equal(hasActiveFilters(DEFAULT_PREFS), false);
    assert.equal(hasActiveFilters({ ...DEFAULT_PREFS, free: true }), true);
    assert.equal(needsAllDetails(DEFAULT_PREFS), false);
    assert.equal(needsAllDetails({ ...DEFAULT_PREFS, sort: 'cheap' }), true);
    assert.equal(needsAllDetails({ ...DEFAULT_PREFS, match: true }), false);
    assert.equal(needsAllDetails({ ...DEFAULT_PREFS, sale: true }), true);
  });
});
