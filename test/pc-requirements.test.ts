import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { htmlToLines, parsePcRequirements } from '../src/pc-requirements.ts';
import { SteamClient } from '../src/steam.ts';

const MINIMUM = '<strong>Mínimos:</strong><br><ul class="bb_ul"><li><strong>SO *: </strong>Windows&nbsp;10 (64&#8209;bit)<br></li>'
  + '<li><strong>Procesador: </strong>Intel Core i5-8400 &amp; similar<br></li>'
  + '<li><strong>Memoria: </strong>8 GB de RAM<br></li>'
  + '<li><strong>Gráficos: </strong><span class="x">NVIDIA <em>GTX</em> 1060</span><br></li>'
  + '<li><strong>Almacenamiento: </strong>50 GB de espacio disponible</li></ul>';
const RECOMMENDED = '<strong>Recomendados:</strong><br><ul class="bb_ul"><li><strong>Memoria: </strong>16 GB de RAM<br></li></ul>';

describe('parsePcRequirements', () => {
  test('strips nested tags, <br>, entities and the section heading into clean lines', () => {
    const parsed = parsePcRequirements({ minimum: MINIMUM, recommended: RECOMMENDED });
    assert.deepEqual(parsed?.minimum, [
      'SO *: Windows 10 (64‑bit)', 'Procesador: Intel Core i5-8400 & similar', 'Memoria: 8 GB de RAM',
      'Gráficos: NVIDIA GTX 1060', 'Almacenamiento: 50 GB de espacio disponible',
    ]);
    assert.deepEqual(parsed?.recommended, ['Memoria: 16 GB de RAM']);
  });

  test('missing recommended keeps minimum; nothing usable gives null', () => {
    assert.deepEqual(parsePcRequirements({ minimum: MINIMUM })?.recommended, []);
    assert.equal(parsePcRequirements([]), null); // Steam sends [] for console-only games
    assert.equal(parsePcRequirements(null), null);
    assert.equal(parsePcRequirements('x'), null);
    assert.equal(parsePcRequirements({ minimum: '<strong>Minimum:</strong><br>' }), null);
    assert.equal(parsePcRequirements({ minimum: 7, recommended: {} }), null);
  });

  test('never lets markup through, even encoded or unterminated', () => {
    const hostile = '<li>OS: <script>alert(1)</script>Win</li><li>&lt;img src=x onerror=alert(1)&gt;</li><li>GPU: <b';
    const lines = htmlToLines(hostile);
    for (const line of lines) assert.doesNotMatch(line, /[<>]/);
    assert.ok(lines.some((l) => l.startsWith('OS:')));
  });

  test('caps the number of lines and their length', () => {
    const many = Array.from({ length: 40 }, (_, i) => `<li>Line ${i}</li>`).join('');
    assert.equal(htmlToLines(many).length, 12);
    assert.equal(htmlToLines(`<li>${'x'.repeat(5000)}</li>`)[0].length, 200);
  });

  test('numeric entities out of range do not throw', () => {
    assert.doesNotThrow(() => htmlToLines('<li>a&#99999999999;b&#x110000;c</li>'));
  });
});

describe('SteamClient pcRequirements', () => {
  const GAMES = [{ id: 'a', steamId: 100, players: [1, 4] as [number, number], platforms: ['PC'] }];

  function client(data: unknown, cacheFile: string | null = null) {
    const fetchImpl = (async (input: string | URL | Request) => {
      const appId = new URL(String(input)).searchParams.get('appids') ?? '';
      return new Response(JSON.stringify({ [appId]: { success: true, data } }), { status: 200 });
    }) as typeof fetch;
    return new SteamClient({ games: GAMES, country: 'ar', fetchImpl, cacheFile, log: () => {} });
  }

  test('details carry parsed requirements, or null when Steam has none', async () => {
    const withReqs = await client({ name: 'X', pc_requirements: { minimum: MINIMUM } }).getDetails('100');
    assert.equal((withReqs.pcRequirements as { minimum: string[] }).minimum[0], 'SO *: Windows 10 (64‑bit)');
    const without = await client({ name: 'X', pc_requirements: [] }).getDetails('100');
    assert.equal(without.pcRequirements, null);
  });

  test('a cache entry without the field is refetched but still served as stale', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qj-req-'));
    const cacheFile = path.join(dir, 'cache.json');
    const legacy = { name: 'Old', movies: [], screenshotThumbs: [] };
    fs.writeFileSync(cacheFile, JSON.stringify({ 100: { at: Date.now(), details: legacy } }));
    try {
      const c = client({ name: 'New', pc_requirements: { minimum: MINIMUM } }, cacheFile);
      assert.equal(c.staleDetails('100')?.pcRequirements, undefined);
      assert.equal((await c.getDetails('100')).name, 'New');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
