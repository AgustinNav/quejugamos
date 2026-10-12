import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { UpstreamQueue } from '../src/upstream-queue.ts';

type Deferred = { promise: Promise<string>; resolve: (v: string) => void; reject: (e: Error) => void };

function deferred(): Deferred {
  let resolve!: (v: string) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<string>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const tick = () => new Promise((r) => setImmediate(r));

/** Queue with no spacing: only concurrency and ordering are under test. */
function unspacedQueue(maxConcurrent: number) {
  return new UpstreamQueue({ maxConcurrent, minIntervalMs: 0 });
}

describe('UpstreamQueue', () => {
  test('never runs more than maxConcurrent jobs at once', async () => {
    const queue = unspacedQueue(3);
    const jobs = Array.from({ length: 10 }, () => deferred());
    let running = 0;
    let peak = 0;
    const results = jobs.map((d, i) => queue.run(`k${i}`, 'background', async () => {
      running += 1;
      peak = Math.max(peak, running);
      try { return await d.promise; } finally { running -= 1; }
    }));
    for (const d of jobs) { await tick(); d.resolve('ok'); }
    assert.deepEqual(await Promise.all(results), Array(10).fill('ok'));
    assert.equal(peak, 3);
  });

  test('interactive jobs run before queued background jobs', async () => {
    const queue = unspacedQueue(1);
    const order: string[] = [];
    const gate = deferred();
    const first = queue.run('busy', 'background', () => gate.promise);
    const bg = queue.run('bg', 'background', async () => { order.push('bg'); return 'bg'; });
    const fg = queue.run('fg', 'interactive', async () => { order.push('fg'); return 'fg'; });
    gate.resolve('busy');
    await Promise.all([first, bg, fg]);
    assert.deepEqual(order, ['fg', 'bg']);
  });

  test('promote moves a queued background job ahead of other background work', async () => {
    const queue = unspacedQueue(1);
    const order: string[] = [];
    const gate = deferred();
    const first = queue.run('busy', 'background', () => gate.promise);
    const a = queue.run('a', 'background', async () => { order.push('a'); return 'a'; });
    const b = queue.run('b', 'background', async () => { order.push('b'); return 'b'; });
    queue.promote('b');
    gate.resolve('busy');
    await Promise.all([first, a, b]);
    assert.deepEqual(order, ['b', 'a']);
  });

  test('a failing job rejects its caller and frees the slot', async () => {
    const queue = unspacedQueue(1);
    const failing = queue.run('x', 'interactive', async () => { throw new Error('boom'); });
    const next = queue.run('y', 'interactive', async () => 'after');
    await assert.rejects(failing, /boom/);
    assert.equal(await next, 'after');
    await tick(); // the slot is released in the job's finally, after its caller resolves
    assert.deepEqual(queue.size, { queued: 0, active: 0 });
  });

  test('spaces job starts by minIntervalMs', async () => {
    let clock = 0;
    const timers: Array<{ at: number; fn: () => void }> = [];
    const queue = new UpstreamQueue({
      maxConcurrent: 5, minIntervalMs: 200, now: () => clock,
      setTimer: (fn, ms) => void timers.push({ at: clock + ms, fn }),
    });
    const starts: number[] = [];
    const done = [0, 1, 2].map((i) => queue.run(`k${i}`, 'background', async () => { starts.push(clock); return i; }));
    await tick();
    while (timers.length > 0) {
      const timer = timers.shift()!;
      clock = timer.at;
      timer.fn();
      await tick();
    }
    await Promise.all(done);
    assert.deepEqual(starts, [0, 200, 400]);
  });
});
