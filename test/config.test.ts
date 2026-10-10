import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.ts';

describe('loadConfig: trusted proxy hops', () => {
  test('defaults to 0 (ignore X-Forwarded-For)', () => {
    assert.equal(loadConfig({}).trustedProxyHops, 0);
  });

  test('TRUST_PROXY=1 keeps meaning one hop', () => {
    assert.equal(loadConfig({ TRUST_PROXY: '1' }).trustedProxyHops, 1);
  });

  test('TRUSTED_PROXY_HOPS overrides TRUST_PROXY', () => {
    assert.equal(loadConfig({ TRUST_PROXY: '1', TRUSTED_PROXY_HOPS: '2' }).trustedProxyHops, 2);
  });

  test('invalid TRUSTED_PROXY_HOPS falls back to TRUST_PROXY', () => {
    for (const bad of ['-1', '9', 'abc', '1.5']) {
      assert.equal(loadConfig({ TRUST_PROXY: '1', TRUSTED_PROXY_HOPS: bad }).trustedProxyHops, 1, bad);
    }
  });

  test('proxy header logging is off unless LOG_PROXY_HEADERS=1', () => {
    assert.equal(loadConfig({}).logProxyHeaders, false);
    assert.equal(loadConfig({ LOG_PROXY_HEADERS: '1' }).logProxyHeaders, true);
  });
});
