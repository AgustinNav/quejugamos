import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startTestServer } from './helpers.ts';
import type { TestServer } from './helpers.ts';
import { cacheControlFor, createFileCache, etagMatches, strongEtag } from '../src/static-cache.ts';

describe('static-cache helpers', () => {
  test('strongEtag is quoted, stable and content-sensitive', () => {
    assert.match(strongEtag('a'), /^"[A-Za-z0-9_-]{27}"$/);
    assert.equal(strongEtag('a'), strongEtag(Buffer.from('a')));
    assert.notEqual(strongEtag('a'), strongEtag('b'));
  });

  test('etagMatches: exact, list, weak prefix, wildcard, absent', () => {
    const tag = strongEtag('x');
    assert.equal(etagMatches(tag, tag), true);
    assert.equal(etagMatches(`"nope", ${tag}`, tag), true);
    assert.equal(etagMatches(`W/${tag}`, tag), true);
    assert.equal(etagMatches('*', tag), true);
    assert.equal(etagMatches(undefined, tag), false);
    assert.equal(etagMatches('', tag), false);
    assert.equal(etagMatches('"garbage', tag), false);
  });

  test('cacheControlFor: code revalidates, images are cached a day', () => {
    assert.equal(cacheControlFor('/x/js/room.js'), 'no-cache');
    assert.equal(cacheControlFor('/x/styles.css'), 'no-cache');
    assert.equal(cacheControlFor('/x/vendor/hls.min.js'), 'no-cache');
    assert.equal(cacheControlFor('/x/og-image.png'), 'public, max-age=86400');
    assert.equal(cacheControlFor('/x/OG.PNG'), 'public, max-age=86400');
  });

  test('createFileCache re-hashes when the file changes on disk', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qj-cache-'));
    const file = path.join(dir, 'a.js');
    try {
      await fs.writeFile(file, 'one');
      const read = createFileCache();
      const first = await read(file);
      assert.equal(first.etag, strongEtag('one'));
      assert.equal(await read(file), first, 'unchanged file is served from memory');
      await fs.writeFile(file, 'two!');
      assert.equal((await read(file)).etag, strongEtag('two!'));
      await assert.rejects(read(dir));
      await assert.rejects(read(path.join(dir, 'missing.js')));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

type RawResponse = { status: number; headers: http.IncomingHttpHeaders; body: string };

function request(port: number, pathname: string, method = 'GET', headers: Record<string, string> = {}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('static files: Cache-Control, ETag and 304', () => {
  let srv: TestServer;
  before(async () => { srv = await startTestServer(); });
  after(async () => { await srv.close(); });

  for (const pathname of ['/', '/r/ABC234', '/index.html', '/app.js', '/js/room.js', '/styles.css', '/games.js', '/vendor/hls.min.js']) {
    test(`${pathname}: no-cache + ETag, 304 on match, 200 on mismatch`, async () => {
      const first = await request(srv.port, pathname);
      assert.equal(first.status, 200);
      assert.equal(first.headers['cache-control'], 'no-cache');
      const etag = String(first.headers.etag);
      assert.match(etag, /^"[A-Za-z0-9_-]{27}"$/);
      assert.ok(first.body.length > 0);

      const hit = await request(srv.port, pathname, 'GET', { 'If-None-Match': etag });
      assert.equal(hit.status, 304);
      assert.equal(hit.body, '');
      assert.equal(hit.headers.etag, etag);
      assert.equal(hit.headers['cache-control'], 'no-cache');
      assert.match(String(hit.headers['content-security-policy']), /script-src 'self'/);
      assert.equal(hit.headers['x-content-type-options'], 'nosniff');

      const miss = await request(srv.port, pathname, 'GET', { 'If-None-Match': '"stale"' });
      assert.equal(miss.status, 200);
      assert.equal(miss.body, first.body);

      const head = await request(srv.port, pathname, 'HEAD');
      assert.equal(head.status, 200);
      assert.equal(head.body, '');
      assert.equal(head.headers.etag, etag);
      const headHit = await request(srv.port, pathname, 'HEAD', { 'If-None-Match': etag });
      assert.equal(headHit.status, 304);
    });
  }

  test('the SPA fallback shares the index ETag and keeps noindex on /r/', async () => {
    const root = await request(srv.port, '/');
    const room = await request(srv.port, '/r/ABC234');
    assert.equal(room.headers.etag, root.headers.etag);
    assert.equal(room.headers['x-robots-tag'], 'noindex');
    const hit = await request(srv.port, '/r/ABC234', 'GET', { 'If-None-Match': String(root.headers.etag) });
    assert.equal(hit.status, 304);
    assert.equal(hit.headers['x-robots-tag'], 'noindex');
  });

  test('images are cacheable for a day', async () => {
    const png = await request(srv.port, '/og-image.png', 'HEAD');
    assert.equal(png.status, 200);
    assert.equal(png.headers['cache-control'], 'public, max-age=86400');
    assert.ok(png.headers.etag);
  });

  test('malformed If-None-Match and missing files never crash', async () => {
    const weird = await request(srv.port, '/styles.css', 'GET', { 'If-None-Match': ',,,W/"' });
    assert.equal(weird.status, 200);
    assert.equal((await request(srv.port, '/js/nope.js', 'GET', { 'If-None-Match': '*' })).status, 404);
    assert.equal((await request(srv.port, '/js', 'GET')).status, 404);
    assert.equal((await request(srv.port, '/healthz')).status, 200);
  });
});
