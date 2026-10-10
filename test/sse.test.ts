import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { SseHub } from '../src/sse.ts';
import type { Snapshot } from '../src/rooms.ts';

/** Minimal ServerResponse: records writes and lets the test pretend the client stopped reading. */
class FakeRes extends EventEmitter {
  writableLength = 0;
  writes: string[] = [];
  destroyed = false;
  ended = false;
  writeHead() { return this; }
  write(chunk: string) { this.writes.push(chunk); return true; }
  end(chunk?: string) { if (chunk) this.writes.push(chunk); this.ended = true; this.emit('close'); }
  destroy() { this.destroyed = true; setImmediate(() => this.emit('close')); }
}

function snapshot(code: string, version = 1): Snapshot {
  return {
    code, phase: 'lobby', players: [], filters: null, deck: [], index: 0, votes: {}, currentVoters: [],
    lastResult: null, results: {}, version,
  };
}

const hubs: SseHub[] = [];
function makeHub(options: ConstructorParameters<typeof SseHub>[0] = {}) {
  const hub = new SseHub({ pingMs: 60_000, ...options });
  hubs.push(hub);
  return hub;
}
afterEach(() => { for (const hub of hubs.splice(0)) hub.closeAll(); });

function connect(hub: SseHub, code: string, ip: string) {
  const res = new FakeRes();
  const ok = hub.connect(code, res as unknown as ServerResponse, snapshot(code), ip);
  return { res, ok };
}

describe('SseHub backpressure', () => {
  test('a client whose buffer exceeds the threshold is destroyed and dropped on broadcast', async () => {
    const hub = makeHub({ maxBufferedBytes: 1024 });
    const reader = connect(hub, 'ROOM01', '1.1.1.1');
    const stalled = connect(hub, 'ROOM01', '2.2.2.2');
    stalled.res.writableLength = 1025;
    hub.broadcast('ROOM01', snapshot('ROOM01', 2));
    assert.equal(stalled.res.destroyed, true);
    assert.equal(stalled.res.writes.length, 1, 'no write after the threshold');
    assert.equal(reader.res.writes.length, 2);
    assert.equal(hub.connectionCount('ROOM01'), 1);
    assert.equal(hub.connectionsFrom('2.2.2.2'), 0);
    await new Promise((r) => setImmediate(r)); // the later 'close' event must not double-release
    assert.equal(hub.connectionCount(), 1);
    assert.equal(hub.connectionsFrom('1.1.1.1'), 1);
  });

  test('a buffer at the threshold is still written', () => {
    const hub = makeHub({ maxBufferedBytes: 1024 });
    const client = connect(hub, 'ROOM01', '1.1.1.1');
    client.res.writableLength = 1024;
    hub.broadcast('ROOM01', snapshot('ROOM01', 2));
    assert.equal(client.res.destroyed, false);
    assert.equal(client.res.writes.length, 2);
  });

  test('pings also drop stalled clients', async () => {
    const hub = makeHub({ maxBufferedBytes: 1024, pingMs: 10 });
    const stalled = connect(hub, 'ROOM01', '1.1.1.1');
    stalled.res.writableLength = 64 * 1024;
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(stalled.res.destroyed, true);
    assert.equal(hub.connectionCount(), 0);
  });

  test('default threshold is 64 KB', () => {
    const hub = makeHub();
    const client = connect(hub, 'ROOM01', '1.1.1.1');
    client.res.writableLength = 64 * 1024;
    hub.broadcast('ROOM01', snapshot('ROOM01', 2));
    assert.equal(client.res.destroyed, false);
    client.res.writableLength = 64 * 1024 + 1;
    hub.broadcast('ROOM01', snapshot('ROOM01', 3));
    assert.equal(client.res.destroyed, true);
  });
});

describe('SseHub connection caps', () => {
  test('per-IP cap (default 20) is enforced across rooms and released on disconnect', () => {
    const hub = makeHub();
    const open = [];
    for (let i = 0; i < 20; i += 1) {
      const c = connect(hub, `ROOM${String(i % 3).padStart(2, '0')}`, '6.6.6.6');
      assert.equal(c.ok, true);
      open.push(c);
    }
    assert.equal(connect(hub, 'ROOM00', '6.6.6.6').ok, false);
    assert.equal(connect(hub, 'ROOM00', '7.7.7.7').ok, true, 'other clients are unaffected');
    open[0].res.emit('close');
    assert.equal(hub.connectionsFrom('6.6.6.6'), 19);
    assert.equal(connect(hub, 'ROOM00', '6.6.6.6').ok, true);
  });

  test('global cap is enforced and released on disconnect', () => {
    const hub = makeHub({ maxTotal: 3 });
    const first = connect(hub, 'ROOM01', '1.1.1.1');
    connect(hub, 'ROOM02', '2.2.2.2');
    connect(hub, 'ROOM03', '3.3.3.3');
    assert.equal(connect(hub, 'ROOM04', '4.4.4.4').ok, false);
    first.res.emit('close');
    assert.equal(connect(hub, 'ROOM04', '4.4.4.4').ok, true);
  });

  test('per-room cap still applies', () => {
    const hub = makeHub({ maxPerRoom: 2 });
    connect(hub, 'ROOM01', '1.1.1.1');
    connect(hub, 'ROOM01', '2.2.2.2');
    assert.equal(connect(hub, 'ROOM01', '3.3.3.3').ok, false);
    assert.equal(connect(hub, 'ROOM02', '3.3.3.3').ok, true);
  });

  test('closing a room releases its connections from every counter', () => {
    const hub = makeHub({ maxPerIp: 2 });
    const a = connect(hub, 'ROOM01', '1.1.1.1');
    connect(hub, 'ROOM01', '1.1.1.1');
    hub.close('ROOM01');
    assert.ok(a.res.writes.at(-1)?.startsWith('event: closed'));
    assert.equal(hub.connectionCount(), 0);
    assert.equal(hub.connectionsFrom('1.1.1.1'), 0);
    assert.equal(connect(hub, 'ROOM02', '1.1.1.1').ok, true);
  });
});
