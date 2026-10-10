// Server-Sent Events hub: one set of open responses per room.
import type { ServerResponse } from 'node:http';
import type { Snapshot } from './rooms.ts';

export type SseHubOptions = { maxPerRoom?: number; pingMs?: number };

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no', // Disable buffering in nginx-style proxies.
};

function stateEvent(snapshot: Snapshot): string {
  return `event: state\ndata: ${JSON.stringify(snapshot)}\n\n`;
}

export class SseHub {
  private readonly rooms = new Map<string, Set<ServerResponse>>();
  private readonly maxPerRoom: number;
  private readonly pingTimer: NodeJS.Timeout;

  constructor(options: SseHubOptions = {}) {
    this.maxPerRoom = options.maxPerRoom ?? 50;
    this.pingTimer = setInterval(() => this.pingAll(), options.pingMs ?? 25_000);
    this.pingTimer.unref();
  }

  /** Opens the stream and sends the initial state. Returns false when the room is at its connection cap. */
  connect(code: string, res: ServerResponse, snapshot: Snapshot): boolean {
    const clients = this.rooms.get(code) ?? new Set<ServerResponse>();
    if (clients.size >= this.maxPerRoom) return false;
    clients.add(res);
    this.rooms.set(code, clients);
    res.writeHead(200, SSE_HEADERS);
    res.write(stateEvent(snapshot));
    res.on('close', () => this.disconnect(code, res));
    return true;
  }

  broadcast(code: string, snapshot: Snapshot): void {
    const payload = stateEvent(snapshot);
    for (const res of this.rooms.get(code) ?? []) res.write(payload);
  }

  /** Sends `event: closed` and ends every stream of the room. */
  close(code: string): void {
    const clients = this.rooms.get(code);
    this.rooms.delete(code);
    for (const res of clients ?? []) res.end('event: closed\ndata: {}\n\n');
  }

  closeAll(): void {
    for (const code of [...this.rooms.keys()]) this.close(code);
    clearInterval(this.pingTimer);
  }

  connectionCount(code?: string): number {
    if (code !== undefined) return this.rooms.get(code)?.size ?? 0;
    let total = 0;
    for (const clients of this.rooms.values()) total += clients.size;
    return total;
  }

  private disconnect(code: string, res: ServerResponse): void {
    const clients = this.rooms.get(code);
    if (!clients) return;
    clients.delete(res);
    if (clients.size === 0) this.rooms.delete(code);
  }

  private pingAll(): void {
    for (const clients of this.rooms.values()) {
      for (const res of clients) res.write(': ping\n\n');
    }
  }
}
