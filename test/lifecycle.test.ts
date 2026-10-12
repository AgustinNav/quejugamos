import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, eventsPath, openRoomSse, startTestServer } from './helpers.ts';

test('6th room from the same IP within an hour gets 429 rate_limited', async () => {
  const srv = await startTestServer();
  const base = `http://127.0.0.1:${srv.port}`;
  try {
    for (let i = 0; i < 5; i += 1) assert.equal((await api(base, 'POST', '/api/rooms', { hostName: 'H' })).status, 201);
    const limited = await api(base, 'POST', '/api/rooms', { hostName: 'H' });
    assert.equal(limited.status, 429);
    assert.equal(limited.body.error, 'rate_limited');
  } finally {
    await srv.close();
  }
});

test('SSE connection cap per room answers 503', async () => {
  const srv = await startTestServer({ sse: { maxPerRoom: 1 } });
  const base = `http://127.0.0.1:${srv.port}`;
  const room = await api(base, 'POST', '/api/rooms', { hostName: 'H' });
  const first = await openRoomSse(base, room.body.code, room.body.hostToken);
  try {
    const second = await api(base, 'GET', await eventsPath(base, room.body.code, room.body.hostToken));
    assert.equal(second.status, 503);
  } finally {
    first.close();
    await srv.close();
  }
});

test('graceful close sends event: closed to SSE clients and stops the server', async () => {
  const srv = await startTestServer();
  const base = `http://127.0.0.1:${srv.port}`;
  const room = await api(base, 'POST', '/api/rooms', { hostName: 'H' });
  const sse = await openRoomSse(base, room.body.code, room.body.hostToken);
  await sse.waitFor((e) => e.event === 'state');
  await srv.close();
  await sse.waitFor((e) => e.event === 'closed');
  await sse.ended;
  await assert.rejects(fetch(`${base}/healthz`));
});
