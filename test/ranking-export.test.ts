import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildExport, formatDate, formatRankingText, likersLabel } from '../public/js/ranking-export.js';

const res = (gameId: string, likes: number, nopes = 0, o: Record<string, unknown> = {}) => ({ gameId, likes, nopes, played: 0, playedOut: false, match: false, ...o });
const NAMES: Record<string, string> = { peak: 'PEAK', repo: 'R.E.P.O.', old: 'Old Game', ghost: '' };
const nameOf = (id: string) => NAMES[id];
const now = new Date(2026, 9, 14);

function state(o: Record<string, unknown> = {}) {
  return {
    code: 'K7Q2MX',
    phase: 'finished',
    players: [{ id: 'p1', name: 'Agus Navarro' }, { id: 'p2', name: 'Juli' }],
    deck: ['repo', 'peak', 'old', 'ghost'],
    index: 4,
    votes: { peak: { p1: 'like', p2: 'like' }, repo: { p1: 'like', p2: 'nope' } },
    results: {
      repo: res('repo', 1, 1),
      peak: res('peak', 2, 0, { match: true }),
      old: res('old', 0, 0, { played: 2, playedOut: true }),
      ghost: res('ghost', 9),
    },
    ...o,
  };
}

describe('ranking-export', () => {
  test('orders by likes, marks matches, uses first names, skips unknown games', () => {
    const m = buildExport(state(), { nameOf, now });
    assert.deepEqual(m.items.map((i: { name: string }) => i.name), ['PEAK', 'R.E.P.O.']);
    assert.deepEqual(m.players, ['Agus', 'Juli']);
    assert.deepEqual(m.items[0].likers, ['Agus', 'Juli']);
    assert.equal(m.items[0].match, true);
    assert.deepEqual(m.played, ['Old Game']);
    assert.equal(m.date, '14/10/2026');
  });

  test('caps at max and reports the total', () => {
    const m = buildExport(state(), { nameOf, now, max: 1 });
    assert.equal(m.items.length, 1);
    assert.equal(m.total, 2);
    assert.match(formatRankingText(m), /… y 1 más/);
  });

  test('text format: position, match marker, likes, names', () => {
    const text = formatRankingText(buildExport(state(), { nameOf, now }));
    assert.match(text, /^¿Qué Jugamos\? — ranking del 14\/10\/2026/);
    assert.match(text, /1\. 💘 PEAK — 2 👍 \(Agus, Juli\)/);
    assert.match(text, /2\. R\.E\.P\.O\. — 1 👍 \(Agus\)/);
    assert.match(text, /Ya jugados: Old Game/);
    assert.match(text, /quejugamos\.com\.ar$/);
  });

  test('empty ranking still produces valid text', () => {
    const m = buildExport(state({ results: {}, index: 0 }), { nameOf, now });
    assert.equal(m.hasResults, false);
    assert.match(formatRankingText(m), /No se llegó a votar ningún juego\./);
  });

  test('likers are truncated with an ellipsis; none = no parentheses', () => {
    assert.equal(likersLabel(['a', 'b', 'c', 'd', 'e']), 'a, b, c, d…');
    assert.equal(likersLabel([]), '');
    const m = buildExport(state({ votes: {} }), { nameOf, now });
    assert.doesNotMatch(formatRankingText(m), /\(/);
  });

  test('formatDate pads day and month', () => {
    assert.equal(formatDate(new Date(2026, 0, 5)), '05/01/2026');
  });
});
