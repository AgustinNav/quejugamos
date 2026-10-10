// Pure room domain: no HTTP, no timers. Clock and randomness are injected so tests are deterministic.
import { timingSafeEqual } from 'node:crypto';

export type Phase = 'lobby' | 'voting' | 'finished';
export type Vote = 'like' | 'nope';
export type Filters = { platforms: string[]; maxPrice: number | null; fitsGroup: boolean };
export type PublicPlayer = { id: string; name: string; isHost: boolean };
export type CardResult = { gameId: string; likes: number; nopes: number; match: boolean };

export type Snapshot = {
  code: string;
  phase: Phase;
  players: PublicPlayer[];
  filters: Filters | null;
  deck: string[];
  index: number;
  votes: Record<string, Record<string, Vote>>;
  lastResult: CardResult | null;
  // Frozen at close time, so players joining later can't turn a past match into a non-match.
  results: Record<string, CardResult>;
  version: number;
};

type Player = PublicPlayer & { token: string };

type Room = Omit<Snapshot, 'players' | 'results'> & {
  players: Player[];
  hostToken: string;
  history: CardResult[];
  lastActivity: number;
};

export type DeckBuilder = (filters: Filters, playerCount: number) => string[];

export type RoomStoreDeps = {
  now: () => number;
  randomInt: (maxExclusive: number) => number;
  uuid: () => string;
  onExpire?: (code: string) => void;
};

export type RoomLimits = {
  maxPlayers: number;
  maxRooms: number;
  roomsPerIpPerWindow: number;
  ipWindowMs: number;
  ttlMs: number;
};

export const DEFAULT_LIMITS: RoomLimits = {
  maxPlayers: 12,
  maxRooms: 500,
  roomsPerIpPerWindow: 5,
  ipWindowMs: 60 * 60 * 1000,
  ttlMs: 2 * 60 * 60 * 1000,
};

export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_LENGTH = 6;
const NAME_MAX = 16;
const MAX_CODE_ATTEMPTS = 50;
const PLAYER_ID_MAX = 64;
// C0/C1 controls plus bidi overrides/isolates, which can visually spoof another player's name.
const FORBIDDEN_NAME_CHARS = /[\p{Cc}‪-‮⁦-⁩]/u;

/** Domain error carrying the HTTP status and the contract's error code. */
export class RoomError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function normalizeName(input: unknown): string {
  if (typeof input !== 'string') throw new RoomError(400, 'invalid_name', 'Name must be a string');
  const name = input.normalize('NFC').trim();
  const length = [...name].length;
  if (length < 1 || length > NAME_MAX || FORBIDDEN_NAME_CHARS.test(name)) {
    throw new RoomError(400, 'invalid_name', `Name must be 1-${NAME_MAX} characters without control characters`);
  }
  return name;
}

function tokensEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export class RoomStore {
  private readonly rooms = new Map<string, Room>();
  private readonly creationsByIp = new Map<string, number[]>();
  private readonly deps: RoomStoreDeps;
  private readonly limits: RoomLimits;

  constructor(deps: RoomStoreDeps, limits: Partial<RoomLimits> = {}) {
    this.deps = deps;
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  get size(): number {
    return this.rooms.size;
  }

  create(hostName: unknown, ip: string) {
    const name = normalizeName(hostName);
    this.assertCanCreate(ip);
    const code = this.generateCode();
    const host = this.newPlayer(name, true);
    const room: Room = {
      code, phase: 'lobby', players: [host], filters: null, deck: [], index: 0, votes: {},
      lastResult: null, version: 1, hostToken: host.token, history: [], lastActivity: this.deps.now(),
    };
    this.rooms.set(code, room);
    this.recordCreation(ip);
    return { code, hostToken: host.token, playerToken: host.token, playerId: host.id };
  }

  join(code: string, rawName: unknown) {
    const name = normalizeName(rawName);
    const room = this.getRoom(code);
    if (room.phase === 'finished') throw new RoomError(409, 'room_finished', 'The room already finished');
    if (room.players.length >= this.limits.maxPlayers) throw new RoomError(409, 'room_full', 'The room is full');
    const key = name.toLowerCase();
    if (room.players.some((p) => p.name.toLowerCase() === key)) {
      throw new RoomError(409, 'name_taken', 'Another player already uses that name');
    }
    const player = this.newPlayer(name, false);
    room.players.push(player);
    this.touch(room);
    return { playerToken: player.token, playerId: player.id, snapshot: toSnapshot(room) };
  }

  /** Checks host auth and phase without mutating, so callers can do async work (prices) before start(). */
  assertCanStart(code: string, token: string | null): void {
    const room = this.getRoom(code);
    this.requireHost(room, token);
    if (room.phase !== 'lobby') throw new RoomError(409, 'already_started', 'Voting already started');
  }

  start(code: string, token: string | null, filters: Filters, buildDeck: DeckBuilder): Snapshot {
    this.assertCanStart(code, token);
    const room = this.getRoom(code);
    const deck = buildDeck(filters, room.players.length);
    if (deck.length === 0) throw new RoomError(422, 'empty_deck', 'No game matches those filters');
    Object.assign(room, { phase: 'voting', filters, deck, index: 0, votes: {} });
    this.touch(room);
    return toSnapshot(room);
  }

  vote(code: string, token: string | null, gameId: unknown, vote: unknown): Snapshot {
    const room = this.getRoom(code);
    const player = this.requirePlayer(room, token);
    if (typeof gameId !== 'string' || !(vote === 'like' || vote === 'nope' || vote === null)) {
      throw new RoomError(400, 'invalid_vote', 'Expected { gameId: string, vote: "like" | "nope" | null }');
    }
    if (room.phase !== 'voting') throw new RoomError(409, 'not_voting', 'The room is not voting');
    if (room.deck[room.index] !== gameId) throw new RoomError(409, 'not_current_game', 'That game is not the current card');
    if (!applyVote(room, player.id, gameId, vote)) return toSnapshot(room);
    if (everyoneVoted(room)) closeCurrentCard(room);
    this.touch(room);
    return toSnapshot(room);
  }

  next(code: string, token: string | null): Snapshot {
    const room = this.getRoom(code);
    this.requireHost(room, token);
    if (room.phase !== 'voting') throw new RoomError(409, 'not_voting', 'The room is not voting');
    closeCurrentCard(room);
    this.touch(room);
    return toSnapshot(room);
  }

  undo(code: string, token: string | null): Snapshot {
    const room = this.getRoom(code);
    this.requireHost(room, token);
    if (room.phase === 'lobby' || room.index === 0) throw new RoomError(409, 'nothing_to_undo', 'There is no closed card to reopen');
    room.history.pop();
    room.index -= 1;
    delete room.votes[room.deck[room.index]];
    room.phase = 'voting';
    // null instead of the previous result so clients don't replay an old swipe/match animation.
    room.lastResult = null;
    this.touch(room);
    return toSnapshot(room);
  }

  /**
   * Host removes a player (duplicate entry, someone who left). Their token stops working, their vote on
   * the current card is dropped (closed cards keep their frozen results) and, if everyone left already
   * voted, the card closes exactly like an auto-advance.
   */
  kick(code: string, token: string | null, playerId: unknown): Snapshot {
    const room = this.getRoom(code);
    this.requireHost(room, token);
    if (typeof playerId !== 'string' || playerId.length === 0 || playerId.length > PLAYER_ID_MAX) {
      throw new RoomError(400, 'invalid_player', 'Expected { playerId: string }');
    }
    const target = room.players.find((p) => p.id === playerId);
    if (!target) throw new RoomError(404, 'player_not_found', 'That player is not in the room');
    if (target.isHost) throw new RoomError(409, 'cannot_kick_host', 'The host cannot be removed');
    room.players = room.players.filter((p) => p !== target);
    if (room.phase === 'voting') {
      applyVote(room, target.id, room.deck[room.index], null);
      if (everyoneVoted(room)) closeCurrentCard(room);
    }
    this.touch(room);
    return toSnapshot(room);
  }

  snapshot(code: string): Snapshot {
    return toSnapshot(this.getRoom(code));
  }

  /** Removes rooms idle longer than the TTL. Returns the expired codes. */
  expire(): string[] {
    const expired: string[] = [];
    for (const room of this.rooms.values()) {
      if (this.isExpired(room)) expired.push(this.remove(room.code));
    }
    this.pruneCreations();
    return expired;
  }

  private getRoom(rawCode: string): Room {
    const room = this.rooms.get(rawCode.toUpperCase());
    if (!room) throw new RoomError(404, 'room_not_found', 'Room not found');
    if (this.isExpired(room)) {
      this.remove(room.code);
      throw new RoomError(404, 'room_not_found', 'Room not found');
    }
    return room;
  }

  private assertCanCreate(ip: string): void {
    const cutoff = this.deps.now() - this.limits.ipWindowMs;
    const recent = (this.creationsByIp.get(ip) ?? []).filter((at) => at > cutoff);
    this.creationsByIp.set(ip, recent);
    if (recent.length >= this.limits.roomsPerIpPerWindow) {
      throw new RoomError(429, 'rate_limited', 'Too many rooms created from this address, try again later');
    }
    if (this.rooms.size >= this.limits.maxRooms) this.expire();
    if (this.rooms.size >= this.limits.maxRooms) throw new RoomError(503, 'capacity', 'Server is at capacity, try again later');
  }

  // Separate from assertCanCreate: expire() inside it may prune this IP's entry.
  private recordCreation(ip: string): void {
    const times = this.creationsByIp.get(ip) ?? [];
    times.push(this.deps.now());
    this.creationsByIp.set(ip, times);
  }

  private generateCode(): string {
    for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt += 1) {
      let code = '';
      for (let i = 0; i < CODE_LENGTH; i += 1) code += CODE_ALPHABET[this.deps.randomInt(CODE_ALPHABET.length)];
      if (!this.rooms.has(code)) return code;
    }
    throw new RoomError(503, 'capacity', 'Could not allocate a room code');
  }

  private newPlayer(name: string, isHost: boolean): Player {
    const id = `p_${this.deps.uuid().replace(/-/g, '').slice(-10)}`;
    return { id, name, isHost, token: this.deps.uuid() };
  }

  private requirePlayer(room: Room, token: string | null): Player {
    const player = token ? room.players.find((p) => tokensEqual(p.token, token)) : undefined;
    if (!player) throw new RoomError(401, 'unauthorized', 'Missing or invalid token for this room');
    return player;
  }

  private requireHost(room: Room, token: string | null): void {
    const player = this.requirePlayer(room, token);
    if (!tokensEqual(player.token, room.hostToken)) throw new RoomError(403, 'not_host', 'Only the host can do that');
  }

  private touch(room: Room): void {
    room.version += 1;
    room.lastActivity = this.deps.now();
  }

  private isExpired(room: Room): boolean {
    return this.deps.now() - room.lastActivity > this.limits.ttlMs;
  }

  private remove(code: string): string {
    this.rooms.delete(code);
    this.deps.onExpire?.(code);
    return code;
  }

  private pruneCreations(): void {
    const cutoff = this.deps.now() - this.limits.ipWindowMs;
    for (const [ip, times] of this.creationsByIp) {
      if (!times.some((at) => at > cutoff)) this.creationsByIp.delete(ip);
    }
  }
}

/** Returns true when the stored vote actually changed. */
function applyVote(room: Room, playerId: string, gameId: string, vote: Vote | null): boolean {
  const cardVotes = room.votes[gameId] ?? {};
  if ((cardVotes[playerId] ?? null) === vote) return false;
  if (vote === null) delete cardVotes[playerId];
  else cardVotes[playerId] = vote;
  if (Object.keys(cardVotes).length === 0) delete room.votes[gameId];
  else room.votes[gameId] = cardVotes;
  return true;
}

function everyoneVoted(room: Room): boolean {
  const cardVotes = room.votes[room.deck[room.index]] ?? {};
  return room.players.every((p) => cardVotes[p.id] !== undefined);
}

function closeCurrentCard(room: Room): void {
  const gameId = room.deck[room.index];
  const cardVotes = Object.values(room.votes[gameId] ?? {});
  const likes = cardVotes.filter((v) => v === 'like').length;
  const nopes = cardVotes.filter((v) => v === 'nope').length;
  const result = { gameId, likes, nopes, match: likes === room.players.length };
  room.history.push(result);
  room.lastResult = result;
  room.index += 1;
  if (room.index >= room.deck.length) room.phase = 'finished';
}

function toSnapshot(room: Room): Snapshot {
  return structuredClone({
    code: room.code,
    phase: room.phase,
    players: room.players.map(({ id, name, isHost }) => ({ id, name, isHost })),
    filters: room.filters,
    deck: room.deck,
    index: room.index,
    votes: room.votes,
    lastResult: room.lastResult,
    results: Object.fromEntries(room.history.map((r) => [r.gameId, r])),
    version: room.version,
  });
}
