// Server-Sent Events hub: one set of open responses per room.
import type { ServerResponse } from 'node:http';
import type { Snapshot } from './rooms.ts';

export type SseHubOptions = {
  maxPerRoom?: number;
  // Process-wide and per-client caps: open streams are memory we hold until the client leaves.
  maxTotal?: number;
  maxPerIp?: number;
  // A client that stops reading makes writes pile up in our process: past this, it is dropped.
  maxBufferedBytes?: number;
  pingMs?: number;
};

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
  private readonly clientIps = new Map<ServerResponse, string>();
  private readonly perIp = new Map<string, number>();
  private readonly maxPerRoom: number;
  private readonly maxTotal: number;
  private readonly maxPerIp: number;
  private readonly maxBufferedBytes: number;
  private readonly pingTimer: NodeJS.Timeout;

  constructor(options: SseHubOptions = {}) {
    this.maxPerRoom = options.maxPerRoom ?? 50;
    this.maxTotal = options.maxTotal ?? 2000;
    this.maxPerIp = options.maxPerIp ?? 20;
    this.maxBufferedBytes = options.maxBufferedBytes ?? 64 * 1024;
    this.pingTimer = setInterval(() => this.pingAll(), options.pingMs ?? 25_000);
    this.pingTimer.unref();
  }

  /**
   * Opens the stream and sends the initial state. Returns false when the room, the client key
   * (see rateLimitKey) or the whole process is at its connection cap.
   */
  connect(code: string, res: ServerResponse, snapshot: Snapshot, ip: string): boolean {
    const clients = this.rooms.get(code) ?? new Set<ServerResponse>();
    if (clients.size >= this.maxPerRoom || this.clientIps.size >= this.maxTotal) return false;
    if ((this.perIp.get(ip) ?? 0) >= this.maxPerIp) return false;
    clients.add(res);
    this.rooms.set(code, clients);
    this.clientIps.set(res, ip);
    this.perIp.set(ip, (this.perIp.get(ip) ?? 0) + 1);
    res.writeHead(200, SSE_HEADERS);
    res.write(stateEvent(snapshot));
    res.on('close', () => this.disconnect(code, res));
    return true;
  }

  broadcast(code: string, snapshot: Snapshot): void {
    const payload = stateEvent(snapshot);
    for (const res of [...(this.rooms.get(code) ?? [])]) this.send(code, res, payload);
  }

  /** Sends `event: closed` and ends every stream of the room. */
  close(code: string): void {
    const clients = this.rooms.get(code);
    for (const res of [...(clients ?? [])]) {
      this.disconnect(code, res);
      res.end('event: closed\ndata: {}\n\n');
    }
  }

  closeAll(): void {
    for (const code of [...this.rooms.keys()]) this.close(code);
    clearInterval(this.pingTimer);
  }

  connectionCount(code?: string): number {
    if (code !== undefined) return this.rooms.get(code)?.size ?? 0;
    return this.clientIps.size;
  }

  connectionsFrom(ip: string): number {
    return this.perIp.get(ip) ?? 0;
  }

  /** Writes unless the client stopped reading; a stalled client is destroyed instead of buffered. */
  private send(code: string, res: ServerResponse, payload: string): void {
    if (res.writableLength > this.maxBufferedBytes) {
      this.disconnect(code, res);
      res.destroy();
      return;
    }
    res.write(payload);
  }

  // Idempotent: runs from close(), from a dropped slow client and again from the 'close' event.
  private disconnect(code: string, res: ServerResponse): void {
    const clients = this.rooms.get(code);
    if (!clients?.delete(res)) return;
    if (clients.size === 0) this.rooms.delete(code);
    const ip = this.clientIps.get(res);
    this.clientIps.delete(res);
    if (ip === undefined) return;
    const left = (this.perIp.get(ip) ?? 1) - 1;
    if (left > 0) this.perIp.set(ip, left);
    else this.perIp.delete(ip);
  }

  private pingAll(): void {
    for (const [code, clients] of this.rooms) {
      for (const res of [...clients]) this.send(code, res, ': ping\n\n');
    }
  }
}
