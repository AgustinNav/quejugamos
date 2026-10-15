#!/usr/bin/env node
// Daily acquisition/engagement metrics from the server's structured logs (src/log.ts).
// Logs are the source of truth: Render wipes memory on every spin-down, so in-process counters lie.
//
//   node scripts/metrics-from-logs.mjs < render-logs.txt
//   node scripts/metrics-from-logs.mjs --exclude=ABC123,XYZ789 < render-logs.txt
//
// Test rooms (owner's recordings, smoke tests) are excluded by code: the codes listed in
// scripts/excluded-rooms.txt (one per line, # comments) plus any passed with --exclude.
//
// Accepts lines as exported or copied from Render: anything before the first "{" (a timestamp
// prefix) is ignored, and so are lines that are not a JSON object or carry no `time`.
// Days are UTC (the `time` field is ISO 8601 in UTC).
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const EXCLUDED_ROOMS_FILE = fileURLToPath(new URL('./excluded-rooms.txt', import.meta.url));

/** Room codes from a text list: one per line (or comma-separated), `#` starts a comment, case-insensitive. */
export function parseRoomList(text) {
  return new Set(
    text.split(/[\r\n,]+/).map((item) => item.replace(/#.*/, '').trim().toUpperCase()).filter(Boolean),
  );
}

function parseLine(line) {
  const start = line.indexOf('{');
  if (start === -1) return null;
  try {
    const entry = JSON.parse(line.slice(start));
    if (typeof entry !== 'object' || entry === null || typeof entry.time !== 'string') return null;
    const day = entry.time.slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(day) ? { ...entry, day } : null;
  } catch {
    return null;
  }
}

function emptyDay() {
  return { roomsCreated: 0, roomsByRef: {}, roomsViaGuest: 0, playersJoined: 0, cards: new Map() };
}

function record(days, entry) {
  const event = entry.event ?? entry.message;
  if (!days.has(entry.day)) days.set(entry.day, emptyDay());
  const day = days.get(entry.day);
  if (event === 'room_created') {
    day.roomsCreated += 1;
    const ref = typeof entry.ref === 'string' ? entry.ref : 'unknown';
    day.roomsByRef[ref] = (day.roomsByRef[ref] ?? 0) + 1;
    if (entry.viaGuest === true) day.roomsViaGuest += 1;
  } else if (event === 'player_joined') {
    day.playersJoined += 1;
  } else if (event === 'card_closed') {
    // Keyed per card: an undo + re-close replaces the earlier result instead of counting twice.
    day.cards.set(`${entry.roomCode}\u0000${entry.gameId}`, { roomCode: entry.roomCode, match: entry.match === true });
  } else if (event === 'card_reopened') {
    day.cards.delete(`${entry.roomCode}\u0000${entry.gameId}`);
  }
}

/** Aggregates log lines into one row per UTC day, sorted by day. */
export function summarize(lines, { excludeRooms = new Set() } = {}) {
  const days = new Map();
  for (const line of lines) {
    const entry = parseLine(line);
    const excluded = typeof entry?.roomCode === 'string' && excludeRooms.has(entry.roomCode.toUpperCase());
    if (entry && !excluded) record(days, entry);
  }
  return [...days.keys()].sort().map((date) => {
    const day = days.get(date);
    const matched = [...day.cards.values()].filter((c) => c.match);
    return {
      date,
      roomsCreated: day.roomsCreated,
      roomsByRef: Object.fromEntries(Object.entries(day.roomsByRef).sort(([a], [b]) => a.localeCompare(b))),
      roomsViaGuest: day.roomsViaGuest,
      playersJoined: day.playersJoined,
      cardsMatched: matched.length,
      roomsWithMatch: new Set(matched.map((c) => c.roomCode)).size,
    };
  });
}

export function formatSummary(rows) {
  if (rows.length === 0) return 'No log lines with a time field found.\n';
  return rows.map((r) => {
    const refs = Object.entries(r.roomsByRef).map(([ref, n]) => `${ref}=${n}`).join(' ') || '-';
    return [
      `${r.date}`,
      `  rooms created:    ${r.roomsCreated} (${refs})`,
      `  rooms via guest:  ${r.roomsViaGuest}`,
      `  players joined:   ${r.playersJoined}`,
      `  cards matched:    ${r.cardsMatched}`,
      `  rooms with match: ${r.roomsWithMatch}`,
    ].join('\n');
  }).join('\n\n') + '\n';
}

async function readStdin() {
  let text = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

function excludedRooms(argv) {
  let fromFile = new Set();
  try {
    fromFile = parseRoomList(fs.readFileSync(EXCLUDED_ROOMS_FILE, 'utf8'));
  } catch {
    // No list file: nothing excluded by default.
  }
  const flag = argv.find((arg) => arg.startsWith('--exclude='));
  const fromFlag = flag ? parseRoomList(flag.slice('--exclude='.length)) : new Set();
  return new Set([...fromFile, ...fromFlag]);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const rows = summarize((await readStdin()).split(/\r?\n/), { excludeRooms: excludedRooms(process.argv) });
  process.stdout.write(process.argv.includes('--json') ? `${JSON.stringify(rows, null, 2)}\n` : formatSummary(rows));
}
