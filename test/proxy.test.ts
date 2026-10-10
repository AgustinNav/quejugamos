import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.ts';
import type { TestServer } from './helpers.ts';

let srv: TestServer;
let base: string;

before(async () => {
  srv = await startTestServer({ config: { trustedProxyHops: 2, logProxyHeaders: true } });
  base = `http://127.0.0.1:${srv.port}`;
});

after(async () => {
  await srv.close();
});

function createRoom(forwardedFor: string) {
  return fetch(`${base}/api/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': forwardedFor },
    body: JSON.stringify({ hostName: 'Agus' }),
  });
}

describe('client IP behind 2 trusted proxies', () => {
  test('logs proxy headers on room creation with the resolved client IP', async () => {
    const res = await createRoom('6.6.6.6, 203.0.113.7, 10.0.0.9');
    assert.equal(res.status, 201);
    const line = srv.logs.map((l) => JSON.parse(l)).find((l) => l.event === 'proxy_headers');
    assert.ok(line, 'expected a proxy_headers log line');
    assert.deepEqual(line.forwardedFor, ['6.6.6.6', '203.0.113.7', '10.0.0.9']);
    assert.equal(line.resolvedIp, '203.0.113.7');
  });

  test('forged left entries do not bypass the per-IP room creation limit', async () => {
    // 1 room already created by this IP in the previous test; the limit is 5 per hour.
    const statuses: number[] = [];
    for (let i = 1; i <= 5; i++) statuses.push((await createRoom(`${i}.${i}.${i}.${i}, 203.0.113.7, 10.0.0.9`)).status);
    assert.deepEqual(statuses, [201, 201, 201, 201, 429]);
  });

  test('a different real client IP is not affected', async () => {
    assert.equal((await createRoom('198.51.100.4, 10.0.0.9')).status, 201);
  });
});
