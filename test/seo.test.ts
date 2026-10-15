import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { DEFAULT_PUBLIC_ORIGIN, loadConfig } from '../src/config.ts';
import { escapeHtmlAttr, renderIndex, robotsTxt, sitemapXml } from '../src/seo.ts';
import { api, startTestServer } from './helpers.ts';
import type { TestServer } from './helpers.ts';

const GOOGLE = 'abcDEF123_-xyz';
const BING = '0123456789ABCDEF0123456789ABCDEF';

async function get(base: string, path: string) {
  const res = await fetch(base + path);
  return { status: res.status, headers: res.headers, text: await res.text() };
}

describe('loadConfig: PUBLIC_ORIGIN', () => {
  test('defaults to the Render URL without warnings', () => {
    const config = loadConfig({});
    assert.equal(config.publicOrigin, DEFAULT_PUBLIC_ORIGIN);
    assert.deepEqual(config.warnings, []);
  });

  test('accepts http(s) origins, normalized (lowercase host, no trailing slash, default port dropped)', () => {
    const cases: Array<[string, string]> = [
      ['https://quejugamos.com', 'https://quejugamos.com'],
      ['https://QueJugamos.com/', 'https://quejugamos.com'],
      ['http://localhost:4300', 'http://localhost:4300'],
      ['https://quejugamos.com:443', 'https://quejugamos.com'],
    ];
    for (const [input, expected] of cases) {
      const config = loadConfig({ PUBLIC_ORIGIN: input });
      assert.equal(config.publicOrigin, expected, input);
      assert.deepEqual(config.warnings, [], input);
    }
  });

  test('invalid values fall back to the default with a warning', () => {
    for (const bad of ['quejugamos.com', 'ftp://quejugamos.com', 'https://quejugamos.com/app', 'https://a.com?x=1',
      'https://a.com/#x', 'https://user:pw@a.com', 'javascript:alert(1)', 'https://a"b.com', 'https://[::1]']) {
      const config = loadConfig({ PUBLIC_ORIGIN: bad });
      assert.equal(config.publicOrigin, DEFAULT_PUBLIC_ORIGIN, bad);
      assert.equal(config.warnings.length, 1, bad);
      assert.match(config.warnings[0], /PUBLIC_ORIGIN/);
    }
  });
});

describe('loadConfig: site verification tokens', () => {
  test('unset → null; valid → kept', () => {
    assert.equal(loadConfig({}).googleSiteVerification, null);
    assert.equal(loadConfig({}).bingSiteVerification, null);
    const config = loadConfig({ GOOGLE_SITE_VERIFICATION: GOOGLE, BING_SITE_VERIFICATION: BING });
    assert.equal(config.googleSiteVerification, GOOGLE);
    assert.equal(config.bingSiteVerification, BING);
    assert.deepEqual(config.warnings, []);
  });

  test('invalid → ignored with a warning that never echoes the value', () => {
    for (const bad of ['short', 'x'.repeat(101), 'abc"><script>x', 'abc def ghi jkl', 'ünïcødé-tøken']) {
      const config = loadConfig({ GOOGLE_SITE_VERIFICATION: bad, BING_SITE_VERIFICATION: bad });
      assert.equal(config.googleSiteVerification, null, bad);
      assert.equal(config.bingSiteVerification, null, bad);
      assert.equal(config.warnings.length, 2, bad);
      assert.ok(config.warnings.every((w) => !w.includes(bad)), bad);
    }
  });
});

describe('seo rendering', () => {
  test('replaces every origin placeholder and removes the verification marker when unset', () => {
    const html = renderIndex('<a href="__PUBLIC_ORIGIN__/">__PUBLIC_ORIGIN__</a><!--__SITE_VERIFICATION__-->', {
      publicOrigin: 'https://q.example', googleSiteVerification: null, bingSiteVerification: null,
    });
    assert.equal(html, '<a href="https://q.example/">https://q.example</a>');
  });

  test('escapes attribute values', () => {
    assert.equal(escapeHtmlAttr(`a&b<c>"d'`), 'a&#38;b&#60;c&#62;&#34;d&#39;');
  });

  test('robots.txt allows everything and points to the sitemap; sitemap lists only the root', () => {
    assert.equal(robotsTxt('https://q.example'), 'User-agent: *\nAllow: /\n\nSitemap: https://q.example/sitemap.xml\n');
    const xml = sitemapXml('https://q.example');
    assert.equal(xml.match(/<loc>/g)?.length, 1);
    assert.match(xml, /<loc>https:\/\/q\.example\/<\/loc>/);
  });
});

describe('SEO over HTTP (defaults: no verification env)', () => {
  let srv: TestServer;
  let base: string;
  before(async () => {
    srv = await startTestServer({ config: { publicOrigin: 'https://seo.example' } });
    base = `http://127.0.0.1:${srv.port}`;
  });
  after(() => srv.close());

  test('/ has absolute OG/Twitter URLs, canonical and JSON-LD, and no placeholders', async () => {
    const res = await get(base, '/');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /^text\/html/);
    assert.ok(!res.text.includes('__PUBLIC_ORIGIN__'));
    assert.ok(!res.text.includes('__SITE_VERIFICATION__'));
    assert.ok(res.text.includes('<link rel="canonical" href="https://seo.example/">'));
    assert.ok(res.text.includes('<meta property="og:url" content="https://seo.example/">'));
    assert.ok(res.text.includes('<meta property="og:image" content="https://seo.example/og-image.jpg">'));
    assert.ok(res.text.includes('<meta name="twitter:image" content="https://seo.example/og-image.jpg">'));
    assert.ok(!res.text.includes('google-site-verification'));
    assert.ok(!res.text.includes('msvalidate.01'));
    assert.equal(res.headers.get('x-robots-tag'), null);
    const ld = /<script type="application\/ld\+json">([^<]*)<\/script>/.exec(res.text);
    assert.ok(ld, 'JSON-LD block present');
    const data = JSON.parse(ld[1]);
    assert.equal(data['@type'], 'WebApplication');
    assert.equal(data.name, '¿Qué Jugamos?');
    assert.equal(data.url, 'https://seo.example/');
    assert.equal(data.applicationCategory, 'GameApplication');
    assert.equal(data.inLanguage, 'es');
    assert.deepEqual({ price: data.offers.price, currency: data.offers.priceCurrency }, { price: '0', currency: 'USD' });
  });

  test('/index.html is rendered too (never served with raw placeholders)', async () => {
    const res = await get(base, '/index.html');
    assert.equal(res.status, 200);
    assert.ok(!res.text.includes('__PUBLIC_ORIGIN__'));
  });

  test('a spoofed Host header does not change canonical URLs', async () => {
    // fetch() won't override Host, so use node:http.
    const text = await new Promise<string>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: srv.port, path: '/', headers: { Host: 'evil.example' } }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => { body += chunk; });
        res.on('end', () => resolve(body));
      }).on('error', reject);
    });
    assert.ok(text.includes('https://seo.example/'));
    assert.ok(!text.includes('evil.example'));
  });

  test('/r/CODE serves the same tags with X-Robots-Tag: noindex', async () => {
    const root = await get(base, '/');
    const room = await get(base, '/r/ABC234');
    assert.equal(room.status, 200);
    assert.equal(room.headers.get('x-robots-tag'), 'noindex');
    assert.equal(room.text, root.text);
  });

  test('/api/* answers X-Robots-Tag: noindex (success and error)', async () => {
    assert.equal((await api(base, 'GET', '/api/rooms/ABC234')).headers.get('x-robots-tag'), 'noindex');
    assert.equal((await api(base, 'GET', '/api/nope')).headers.get('x-robots-tag'), 'noindex');
    const created = await api(base, 'POST', '/api/rooms', { hostName: 'A' });
    assert.equal(created.headers.get('x-robots-tag'), 'noindex');
  });

  test('static assets and the landing are not noindexed', async () => {
    assert.equal((await get(base, '/styles.css')).headers.get('x-robots-tag'), null);
    assert.equal((await get(base, '/healthz')).headers.get('x-robots-tag'), null);
  });

  test('/robots.txt and /sitemap.xml with the right content types', async () => {
    const robots = await get(base, '/robots.txt');
    assert.equal(robots.status, 200);
    assert.equal(robots.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.match(robots.text, /^User-agent: \*\nAllow: \/\n/);
    assert.ok(robots.text.includes('Sitemap: https://seo.example/sitemap.xml'));
    assert.ok(!robots.text.includes('Disallow'));
    const sitemap = await get(base, '/sitemap.xml');
    assert.equal(sitemap.status, 200);
    assert.equal(sitemap.headers.get('content-type'), 'application/xml; charset=utf-8');
    assert.ok(sitemap.text.includes('<loc>https://seo.example/</loc>'));
  });

  test('HEAD on / and /robots.txt answers headers only', async () => {
    for (const path of ['/', '/robots.txt']) {
      const res = await fetch(base + path, { method: 'HEAD' });
      assert.equal(res.status, 200);
      assert.equal(await res.text(), '');
    }
  });
});

describe('SEO env ON: verification tokens and invalid values read from process.env', () => {
  let srv: TestServer;
  let base: string;
  const saved = { ...process.env };
  before(async () => {
    process.env.PUBLIC_ORIGIN = 'https://env.example';
    process.env.GOOGLE_SITE_VERIFICATION = GOOGLE;
    process.env.BING_SITE_VERIFICATION = BING;
    srv = await startTestServer();
    base = `http://127.0.0.1:${srv.port}`;
  });
  after(async () => {
    await srv.close();
    for (const key of ['PUBLIC_ORIGIN', 'GOOGLE_SITE_VERIFICATION', 'BING_SITE_VERIFICATION']) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  });

  test('injects both verification meta tags and uses PUBLIC_ORIGIN', async () => {
    const res = await get(base, '/');
    assert.ok(res.text.includes(`<meta name="google-site-verification" content="${GOOGLE}">`));
    assert.ok(res.text.includes(`<meta name="msvalidate.01" content="${BING}">`));
    assert.ok(res.text.includes('<link rel="canonical" href="https://env.example/">'));
    assert.ok((await get(base, '/robots.txt')).text.includes('Sitemap: https://env.example/sitemap.xml'));
    assert.ok(!srv.logs.some((l) => l.includes('config_invalid')));
  });

  test('invalid env values are ignored and logged as WARNING at startup', async () => {
    process.env.PUBLIC_ORIGIN = 'https://bad.example/path';
    process.env.GOOGLE_SITE_VERIFICATION = 'bad"token';
    process.env.BING_SITE_VERIFICATION = '';
    const bad = await startTestServer();
    try {
      const res = await get(`http://127.0.0.1:${bad.port}`, '/');
      assert.ok(res.text.includes(`<link rel="canonical" href="${DEFAULT_PUBLIC_ORIGIN}/">`));
      assert.ok(!res.text.includes('google-site-verification'));
      assert.ok(!res.text.includes('msvalidate.01'));
      const warnings = bad.logs.map((l) => JSON.parse(l)).filter((l) => l.event === 'config_invalid');
      assert.equal(warnings.length, 2);
      assert.ok(warnings.every((w) => w.severity === 'WARNING'));
      assert.ok(!bad.logs.join('\n').includes('bad"token'));
    } finally {
      await bad.close();
    }
  });
});
