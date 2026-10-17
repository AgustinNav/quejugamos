import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cardPlatforms, INITIAL_PLATFORMS, showsPcInfo, togglePlatform } from '../public/js/platforms.js';

const PHONE_CSS = (() => {
  const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  const start = css.indexOf('/* COMPACT (phone) LAYOUT');
  assert.ok(start >= 0, 'phone layout block not found in styles.css');
  return css.slice(start);
})();

/** Classes the phone layout hides with display:none (selectors like `.pill.extra`). */
function hiddenOnPhone(className: string): boolean {
  const rules = [...PHONE_CSS.matchAll(/([^{}]+)\{[^}]*display:\s*none[^}]*\}/g)].map((m) => m[1]);
  const classes = new Set(className.split(/\s+/));
  return rules.some((selectors) => selectors.split(',').some((sel) => {
    const required = sel.trim().split('.').slice(1);
    return required.length > 0 && required.every((c) => classes.has(c));
  }));
}

describe('lobby platform selection', () => {
  test('starts with nothing selected: the host picks what the group plays on', () => {
    assert.deepEqual([...INITIAL_PLATFORMS], []);
  });

  test('toggle adds and removes without mutating the input', () => {
    const none: string[] = [];
    const ps = togglePlatform(none, 'PlayStation');
    assert.deepEqual(ps, ['PlayStation']);
    assert.deepEqual(none, []);
    assert.deepEqual(togglePlatform(ps, 'Switch'), ['PlayStation', 'Switch']);
    assert.deepEqual(togglePlatform(ps, 'PlayStation'), []);
  });
});

describe('platforms on the voting card', () => {
  const multi = ['PC', 'PlayStation', 'Xbox'];

  test('the platforms the room chose come first and are marked', () => {
    assert.deepEqual(cardPlatforms(multi, ['PlayStation']).map((p) => [p.name, p.chosen]), [
      ['PlayStation', true], ['PC', false], ['Xbox', false],
    ]);
  });

  // Field bug (2026-10-16): PlayStation-only room on a phone; every platform pill was hidden,
  // so a PC+PlayStation game looked like a PC game (Steam price, Steam button, PC requirements).
  test('on a phone the chosen platform stays visible and the others are hidden', () => {
    for (const p of cardPlatforms(multi, ['PlayStation'])) {
      assert.equal(hiddenOnPhone(p.className), !p.chosen, `${p.name}: "${p.className}"`);
    }
  });

  test('the hiddenOnPhone helper actually reads the phone rules', () => {
    assert.ok(hiddenOnPhone('pill extra'));
    assert.ok(!hiddenOnPhone('pill players'));
  });

  test('a room without filters (old snapshot) shows every platform as chosen', () => {
    assert.ok(cardPlatforms(multi, null).every((p) => p.chosen));
  });

  test('PC-only info (requirements) shows only when the room plays on PC', () => {
    assert.equal(showsPcInfo(['PlayStation']), false);
    assert.equal(showsPcInfo(['PlayStation', 'PC']), true);
    assert.equal(showsPcInfo(null), true);
  });
});
