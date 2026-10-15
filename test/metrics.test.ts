import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatSummary, parseRoomList, summarize } from '../scripts/metrics-from-logs.mjs';

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

describe('excluded test rooms', () => {
  const lines = [
    '{"event":"room_created","time":"2026-10-14T20:00:00Z","roomCode":"BRVVJ2","ref":"direct","viaGuest":false}',
    '{"event":"player_joined","time":"2026-10-14T20:00:05Z","roomCode":"BRVVJ2"}',
    '{"event":"card_closed","time":"2026-10-14T20:01:00Z","roomCode":"BRVVJ2","gameId":"peak","match":true}',
    '{"event":"room_created","time":"2026-10-14T21:00:00Z","roomCode":"REAL01","ref":"tt","viaGuest":false}',
  ];

  test('parseRoomList reads codes, ignores comments and blanks, and is case-insensitive', () => {
    assert.deepEqual([...parseRoomList('# header\nbrvvj2  # recording\n\nABC123,xyz789\n')], ['BRVVJ2', 'ABC123', 'XYZ789']);
  });

  test('every event of an excluded room is left out of the summary', () => {
    const [day] = summarize(lines, { excludeRooms: parseRoomList('brvvj2') });
    assert.equal(day.roomsCreated, 1);
    assert.deepEqual(day.roomsByRef, { tt: 1 });
    assert.equal(day.playersJoined, 0);
    assert.equal(day.cardsMatched, 0);
  });

  test('without exclusions the test room counts', () => {
    const [day] = summarize(lines);
    assert.equal(day.roomsCreated, 2);
    assert.equal(day.cardsMatched, 1);
  });

  test('CLI applies --exclude and the committed list', () => {
    const run = (args: string[]) => execFileSync(process.execPath, [SCRIPT, ...args], { input: lines.join('\n'), encoding: 'utf8' });
    assert.match(run([]), /rooms created: {4}1 \(tt=1\)/, 'BRVVJ2 is in scripts/excluded-rooms.txt');
    assert.match(run(['--exclude=REAL01']), /No log lines/, 'both rooms excluded leaves nothing to summarize');
  });
});
