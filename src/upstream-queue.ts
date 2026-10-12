// Polite access to an undocumented upstream (Steam appdetails): bounded concurrency, a minimum gap
// between request starts, and interactive work (a card someone is looking at) ahead of background
// warm-up. Without it, one cold `start` fired ~100 simultaneous requests and got us rate-limited.

export type Priority = 'interactive' | 'background';

type Job = { key: string; priority: Priority; run: () => Promise<unknown>; settle: (p: Promise<unknown>) => void };

export type UpstreamQueueOptions = {
  maxConcurrent: number;
  minIntervalMs: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => void;
};

export class UpstreamQueue {
  private readonly options: UpstreamQueueOptions;
  private readonly pending: Job[] = [];
  private active = 0;
  private lastStart = -Infinity;
  private timerArmed = false;

  constructor(options: UpstreamQueueOptions) {
    this.options = options;
  }

  /** Queues `run`; resolves/rejects with its result. `key` lets a later interactive caller promote it. */
  run<T>(key: string, priority: Priority, run: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const settle = (p: Promise<unknown>) => (p as Promise<T>).then(resolve, reject);
      this.enqueue({ key, priority, run, settle });
      this.drain();
    });
  }

  /** Moves a queued background job ahead of other background work (someone is waiting on it now). */
  promote(key: string): void {
    const index = this.pending.findIndex((job) => job.key === key && job.priority === 'background');
    if (index === -1) return;
    const [job] = this.pending.splice(index, 1);
    this.enqueue({ ...job, priority: 'interactive' });
  }

  get size(): { queued: number; active: number } {
    return { queued: this.pending.length, active: this.active };
  }

  private enqueue(job: Job): void {
    if (job.priority === 'background') return void this.pending.push(job);
    const firstBackground = this.pending.findIndex((j) => j.priority === 'background');
    this.pending.splice(firstBackground === -1 ? this.pending.length : firstBackground, 0, job);
  }

  private drain(): void {
    while (this.active < this.options.maxConcurrent && this.pending.length > 0) {
      const wait = this.lastStart + this.options.minIntervalMs - this.now();
      if (wait > 0) return this.armTimer(wait);
      this.start(this.pending.shift()!);
    }
  }

  private start(job: Job): void {
    this.active += 1;
    this.lastStart = this.now();
    const result = Promise.resolve().then(job.run);
    job.settle(result);
    result.catch(() => {}).finally(() => {
      this.active -= 1;
      this.drain();
    });
  }

  private armTimer(ms: number): void {
    if (this.timerArmed) return;
    this.timerArmed = true;
    const setTimer = this.options.setTimer ?? ((fn, delay) => void setTimeout(fn, delay).unref());
    setTimer(() => {
      this.timerArmed = false;
      this.drain();
    }, ms);
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}
