import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatSummary, summarize } from '../scripts/metrics-from-logs.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'render-logs.txt');
const SCRIPT = path.join(ROOT, 'scripts', 'metrics-from-logs.mjs');

describe('scripts/metrics-from-logs.mjs', () => {
  test('aggregates per UTC day from the fixture', () => {
    const rows = summarize(fs.readFileSync(FIXTURE, 'utf8').split(/\r?\n/));
    assert.deepEqual(rows, [
      {
        date: '2026-10-12',
        roomsCreated: 3,
        // CCCCCC predates the ref field: counted, labeled unknown.
        roomsByRef: { direct: 1, tt: 1, unknown: 1 },
        roomsViaGuest: 1,
        playersJoined: 2,
        // valheim was matched, reopened and re-closed without a match; played-out closes never count.
        cardsMatched: 2,
        roomsWithMatch: 1,
      },
      {
        date: '2026-10-13',
        roomsCreated: 2,
        roomsByRef: { other: 1, tt: 1 },
        roomsViaGuest: 1,
        playersJoined: 1,
        cardsMatched: 1,
        roomsWithMatch: 1,
      },
    ]);
  });

  test('ignores non-JSON lines, JSON without time and non-object JSON', () => {
    assert.deepEqual(summarize(['', 'hello', '{oops', '[1]', '"x"', '{"event":"room_created"}', '{"time":"nope"}']), []);
  });

  test('runs as a CLI over stdin', () => {
    const out = execFileSync(process.execPath, [SCRIPT], { input: fs.readFileSync(FIXTURE) }).toString();
    assert.equal(out, formatSummary(summarize(fs.readFileSync(FIXTURE, 'utf8').split(/\r?\n/))));
    assert.match(out, /^2026-10-12\n {2}rooms created: {4}3 \(direct=1 tt=1 unknown=1\)/);
    const json = JSON.parse(execFileSync(process.execPath, [SCRIPT, '--json'], { input: '' }).toString());
    assert.deepEqual(json, []);
  });
});
