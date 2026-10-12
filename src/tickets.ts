// Single-use SSE stream tickets. EventSource can't send an Authorization header, so a member trades
// its bearer token for a short-lived ticket that goes in the events URL instead of the token.
// A URL can end up in proxy/access logs: the ticket is useless after one use or TICKET_TTL_MS.
import { randomBytes } from 'node:crypto';

export const TICKET_TTL_MS = 30_000;
// Two tabs/devices of the same player may race for tickets; past this the oldest is dropped.
const MAX_TICKETS_PER_PLAYER = 4;
// 128 random bits as base64url.
export const TICKET_PATTERN = /^[A-Za-z0-9_-]{22}$/;

type Ticket = { code: string; playerId: string; expiresAt: number };

export type TicketStoreDeps = {
  now: () => number;
  random?: () => string;
};

export class StreamTicketStore {
  private readonly tickets = new Map<string, Ticket>();
  private readonly byPlayer = new Map<string, string[]>();
  private readonly now: () => number;
  private readonly random: () => string;

  constructor(deps: TicketStoreDeps) {
    this.now = deps.now;
    this.random = deps.random ?? (() => randomBytes(16).toString('base64url'));
  }

  get size(): number {
    return this.tickets.size;
  }

  issue(code: string, playerId: string): string {
    const key = playerKey(code, playerId);
    const live = (this.byPlayer.get(key) ?? []).filter((t) => this.isLive(t));
    while (live.length >= MAX_TICKETS_PER_PLAYER) this.tickets.delete(live.shift()!);
    const ticket = this.random();
    this.tickets.set(ticket, { code, playerId, expiresAt: this.now() + TICKET_TTL_MS });
    live.push(ticket);
    this.byPlayer.set(key, live);
    return ticket;
  }

  /** Returns the bound playerId and burns the ticket, or null (unknown, expired, reused, other room). */
  consume(ticket: string, code: string): string | null {
    const entry = this.tickets.get(ticket);
    if (!entry) return null;
    this.forget(ticket, entry);
    if (entry.code !== code || entry.expiresAt <= this.now()) return null;
    return entry.playerId;
  }

  dropRoom(code: string): void {
    for (const [ticket, entry] of this.tickets) if (entry.code === code) this.forget(ticket, entry);
  }

  prune(): void {
    for (const [ticket, entry] of this.tickets) if (entry.expiresAt <= this.now()) this.forget(ticket, entry);
  }

  private isLive(ticket: string): boolean {
    const entry = this.tickets.get(ticket);
    return entry !== undefined && entry.expiresAt > this.now();
  }

  private forget(ticket: string, entry: Ticket): void {
    this.tickets.delete(ticket);
    const key = playerKey(entry.code, entry.playerId);
    const rest = (this.byPlayer.get(key) ?? []).filter((t) => t !== ticket && this.tickets.has(t));
    if (rest.length) this.byPlayer.set(key, rest);
    else this.byPlayer.delete(key);
  }
}

function playerKey(code: string, playerId: string): string {
  return `${code}\u0000${playerId}`;
}
