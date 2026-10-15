import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { hlsLikelySupported, loadHls, resetHlsLoader } from '../public/js/hls-loader.js';

function fakeDoc(onAppend: (script: any) => void) {
  const scripts: any[] = [];
  return {
    scripts,
    createElement: () => ({}),
    head: { appendChild: (s: any) => { scripts.push(s); onAppend(s); } },
  };
}

describe('lazy hls.js loader', () => {
  beforeEach(() => resetHlsLoader());

  test('injects one SRI script and shares the promise across calls', async () => {
    const win: any = {};
    const doc = fakeDoc((s) => { win.Hls = class {}; s.onload(); });
    const [a, b] = await Promise.all([loadHls(win, doc as any), loadHls(win, doc as any)]);
    assert.equal(a, win.Hls);
    assert.equal(b, win.Hls);
    assert.equal(doc.scripts.length, 1);
    assert.equal(doc.scripts[0].src, '/vendor/hls.min.js');
    assert.match(doc.scripts[0].integrity, /^sha384-/);
    assert.equal(doc.scripts[0].crossOrigin, 'anonymous');
  });

  test('does not inject when Hls is already present', async () => {
    const win: any = { Hls: class {} };
    const doc = fakeDoc(() => assert.fail('should not append'));
    assert.equal(await loadHls(win, doc as any), win.Hls);
  });

  test('load failure resolves null instead of throwing', async () => {
    const doc = fakeDoc((s) => s.onerror());
    assert.equal(await loadHls({} as any, doc as any), null);
  });

  test('a throwing DOM resolves null', async () => {
    const doc: any = { createElement: () => { throw new Error('boom'); } };
    assert.equal(await loadHls({} as any, doc), null);
  });

  test('MSE probe is false without MediaSource and never throws', () => {
    assert.equal(hlsLikelySupported({} as any), false);
    assert.equal(hlsLikelySupported({ MediaSource: { isTypeSupported: () => { throw new Error('x'); } } } as any), false);
    assert.equal(hlsLikelySupported({ MediaSource: { isTypeSupported: () => true } } as any), true);
  });
});
