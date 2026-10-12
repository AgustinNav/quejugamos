import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { REF_SOURCES, normalizeRef, parseViaGuest } from '../src/acquisition.ts';
import { HttpError } from '../src/http.ts';
import { api, rawPost, startTestServer } from './helpers.ts';
import type { TestServer } from './helpers.ts';

const isInvalidBody = (err: unknown) => err instanceof HttpError && err.status === 400 && err.code === 'invalid_body';

describe('normalizeRef', () => {
  test('every allowlisted source is kept as is', () => {
    const expected = ['tt', 'ig', 'yt', 'x', 'rd', 'dc', 'twitch', 'wa', 'gh', 'qr', 'yo'];
    assert.deepEqual([...REF_SOURCES].sort(), [...expected].sort());
    for (const ref of expected) assert.equal(normalizeRef(ref), ref);
  });

  test('missing or null → direct', () => {
    assert.equal(normalizeRef(undefined), 'direct');
    assert.equal(normalizeRef(null), 'direct');
  });

  test('any other string → other (case-sensitive, no trimming, no prototype keys)', () => {
    for (const ref of ['', 'TT', ' tt', 'tiktok', '<script>', 'constructor', '__proto__', 'x'.repeat(5000)]) {
      assert.equal(normalizeRef(ref), 'other', ref.slice(0, 20));
    }
  });

  test('non-string → 400 invalid_body', () => {
    for (const ref of [1, true, {}, ['tt']]) assert.throws(() => normalizeRef(ref), isInvalidBody);
  });
});

describe('parseViaGuest', () => {
  test('missing → false, booleans kept', () => {
    assert.equal(parseViaGuest(undefined), false);
    assert.equal(parseViaGuest(true), true);
    assert.equal(parseViaGuest(false), false);
  });

  test('anything else → 400 invalid_body', () => {
    for (const value of ['x', 'true', 1, 0, null, {}, []]) assert.throws(() => parseViaGuest(value), isInvalidBody);
  });
});

describe('POST /api/rooms with acquisition fields', () => {
  let srv: TestServer;
  let base: string;
  let ipCounter = 0;

  before(async () => {
    srv = await startTestServer({ config: { trustedProxyHops: 1 }, limits: { roomsPerIpPerWindow: 1 } });
    base = `http://127.0.0.1:${srv.port}`;
  });
  after(() => srv.close());
  beforeEach(() => { srv.logs.length = 0; });

  async function create(body: unknown, ip = `10.20.0.${++ipCounter}`) {
    const res = await fetch(`${base}/api/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  }

  function roomCreatedLines() {
    return srv.logs.map((l) => JSON.parse(l)).filter((l) => l.event === 'room_created');
  }

  async function assertAlive() {
    assert.equal((await api(base, 'GET', '/healthz')).status, 200);
  }

  test('logs the normalized ref and viaGuest, never echoes them', async () => {
    const cases: Array<[unknown, string, boolean]> = [
      [{ hostName: 'A', ref: 'tt', viaGuest: true }, 'tt', true],
      [{ hostName: 'A', ref: '<script>alert(1)</script>' }, 'other', false],
      [{ hostName: 'A' }, 'direct', false],
      [{ hostName: 'A', ref: null, viaGuest: false }, 'direct', false],
    ];
    for (const [body, ref, viaGuest] of cases) {
      srv.logs.length = 0;
      const res = await create(body);
      assert.equal(res.status, 201);
      assert.deepEqual(Object.keys(res.body).sort(), ['code', 'hostToken', 'playerId', 'playerToken']);
      const [line] = roomCreatedLines();
      assert.equal(line.ref, ref);
      assert.equal(line.viaGuest, viaGuest);
      // The ref is not stored in the room either.
      const snapshot = await api(base, 'GET', `/api/rooms/${res.body.code}`);
      assert.ok(!JSON.stringify(snapshot.body).includes('script'));
    }
  });

  test('the room_created line carries no IP, name or token', async () => {
    const res = await create({ hostName: 'Zoltan', ref: 'ig' }, '203.0.113.77');
    assert.equal(res.status, 201);
    const raw = srv.logs.find((l) => l.includes('"room_created"'))!;
    assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ['event', 'liveRooms', 'ref', 'roomCode', 'severity', 'viaGuest']);
    for (const secret of ['203.0.113', 'Zoltan', String(res.body.hostToken), String(res.body.playerToken)]) {
      assert.ok(!raw.includes(secret), secret);
    }
  });

  test('invalid viaGuest / ref → 400 invalid_body, no room and no quota spent', async () => {
    const ip = '10.30.0.1';
    for (const body of [{ hostName: 'A', viaGuest: 'x' }, { hostName: 'A', viaGuest: 1 }, { hostName: 'A', ref: 7 }, { hostName: 'A', ref: ['tt'] }]) {
      const res = await create(body, ip);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(res.body.error, 'invalid_body');
    }
    assert.equal(roomCreatedLines().length, 0);
    // roomsPerIpPerWindow is 1: the rejected attempts must not have used it up.
    assert.equal((await create({ hostName: 'A', ref: 'qr' }, ip)).status, 201);
    await assertAlive();
  });

  test('malformed bodies → 4xx and the process stays up', async () => {
    const cases: Array<[string, string, number]> = [
      ['{"hostName":"A","ref":', 'application/json', 400],
      ['{"hostName":"A","viaGuest":tru}', 'application/json', 400],
      [JSON.stringify({ hostName: 'A', ref: 'x'.repeat(2000) }), 'application/json', 413],
      ['hostName=A&ref=tt', 'application/x-www-form-urlencoded', 415],
      ['null', 'application/json', 400],
      ['["tt"]', 'application/json', 400],
    ];
    for (const [body, type, status] of cases) {
      const res = await rawPost(base, '/api/rooms', body, type);
      assert.equal(res.status, status, body.slice(0, 40));
    }
    await assertAlive();
  });
});
