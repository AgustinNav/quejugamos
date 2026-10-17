// Pure room domain: no HTTP, no timers. Clock and randomness are injected so tests are deterministic.
import { timingSafeEqual } from 'node:crypto';

export type Phase = 'lobby' | 'voting' | 'finished';
// played: "I already played this game". Counts as a cast vote (advances the card) but never as a like.
// superlike: a like that counts double in the ranking; one per player per room (see vote()).
export type Vote = 'like' | 'nope' | 'played' | 'superlike';
export type Filters = { platforms: string[]; maxPrice: number | null; fitsGroup: boolean; playerCount: number | null };
export type PublicPlayer = { id: string; name: string; isHost: boolean };
// playedOut: strict majority of the votes cast on the card were "played" (ranked apart, never a match).
// likes INCLUDES superlikes, so match / playedOut math stays valid; superlikedBy is sorted for determinism.
export type CardResult = {
  gameId: string; likes: number; superlikes: number; superlikedBy: string[]; nopes: number; played: number;
  playedOut: boolean; match: boolean;
};

export type Snapshot = {
  code: string;
  phase: Phase;
  players: PublicPlayer[];
  filters: Filters | null;
  deck: string[];
  index: number;
  // Closed cards only: open-card votes stay private until the card closes (see currentVoters).
  votes: Record<string, Record<string, Vote>>;
  currentVoters: string[];
  lastResult: CardResult | null;
  // Frozen at close time, so players joining later can't turn a past match into a non-match.
  results: Record<string, CardResult>;
  version: number;
};

type Player = PublicPlayer & { token: string };

export type CurrentVote = { playerId: string; gameId: string | null; vote: Vote | null; superlikeAvailable: boolean };

/** What a non-member may see: enough for the join screen, never names, votes, results or the deck. */
export type PublicRoom = { code: string; phase: Phase; playerCount: number; maxPlayers: number };

// idle: TTL without mutations; empty: nobody connected for emptyRoomTtlMs; closed_by_host: POST /close.
export type ExpireReason = 'idle' | 'empty' | 'closed_by_host';

type Room = Omit<Snapshot, 'players' | 'results' | 'currentVoters'> & {
  players: Player[];
  hostToken: string;
  history: CardResult[];
  lastActivity: number;
  // Presence (live SSE streams). emptySince stays null until the room had a first connection.
  liveConnections: number;
  emptySince: number | null;
};

export type DeckBuilder = (filters: Filters, playerCount: number) => string[];

export type RoomStoreDeps = {
  now: () => number;
  randomInt: (maxExclusive: number) => number;
  uuid: () => string;
  onExpire?: (code: string, reason: ExpireReason) => void;
};

export type RoomLimits = {
  maxPlayers: number;
  maxRooms: number;
  roomsPerIpPerWindow: number;
  ipWindowMs: number;
  ttlMs: number;
  // A lobby nobody joined is cheap to create and costs nothing to abandon: it gets a shorter TTL.
  lobbyTtlMs: number;
  // At capacity, a lone-host lobby idle this long is evicted to make room for a new one.
  lobbyEvictIdleMs: number;
  // A room that had live connections and now has none is deleted after this long: names are personal
  // data and an abandoned room should not keep them in memory for the whole idle TTL.
  emptyRoomTtlMs: number;
};

export const DEFAULT_LIMITS: RoomLimits = {
  maxPlayers: 12,
  maxRooms: 500,
  roomsPerIpPerWindow: 5,
  ipWindowMs: 60 * 60 * 1000,
  ttlMs: 2 * 60 * 60 * 1000,
  lobbyTtlMs: 20 * 60 * 1000,
  lobbyEvictIdleMs: 5 * 60 * 1000,
  emptyRoomTtlMs: 10 * 60 * 1000,
};

export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_LENGTH = 6;
const NAME_MAX = 16;
const MAX_CODE_ATTEMPTS = 50;
const PLAYER_ID_MAX = 64;
// Controls, format chars (zero-width, bidi, RLM), line/paragraph separators and the Hangul fillers
// render as nothing or reorder text: a name made of them is invisible or impersonates another player.
const FORBIDDEN_NAME_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}ㅤᅟᅠﾠ]/u;
// ZWJ is \p{Cf} but glues multi-person emoji (e.g. family): allowed only between two pictographs.
const EMOJI_ZWJ = /(?<=\p{Extended_Pictographic}[️\u{1F3FB}-\u{1F3FF}]?)‍(?=\p{Extended_Pictographic})/gu;
const VISIBLE_NAME_CHAR = /[\p{L}\p{N}\p{Extended_Pictographic}]/u;
// Checked on NFD so precomposed letters count their marks too (Vietnamese tops out at 2).
const MARK_STACK = /\p{M}{3}/u;
const IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu;

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
  const valid = length >= 1 && length <= NAME_MAX
    && !FORBIDDEN_NAME_CHARS.test(name.replace(EMOJI_ZWJ, ''))
    && VISIBLE_NAME_CHAR.test(name)
    && !MARK_STACK.test(name.normalize('NFD'));
  if (!valid) {
    throw new RoomError(400, 'invalid_name', `Name must be 1-${NAME_MAX} visible characters (letters, digits or emoji)`);
  }
  return name;
}

/**
 * Key for name uniqueness: compatibility forms (fullwidth, ligatures) and invisible code points fold
 * into the same key. Cross-script look-alikes (Cyrillic "а" vs Latin "a") still differ: full
 * confusable detection (Unicode TR39 skeletons) is out of scope.
 */
export function nameKey(name: string): string {
  return name.normalize('NFKC').toLowerCase().replace(IGNORABLE, '');
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
      liveConnections: 0, emptySince: null,
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
    const key = nameKey(name);
    if (room.players.some((p) => nameKey(p.name) === key)) {
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
    if (typeof gameId !== 'string' || !isVoteValue(vote)) {
      throw new RoomError(400, 'invalid_vote', 'Expected { gameId: string, vote: "like" | "nope" | "played" | "superlike" | null }');
    }
    if (room.phase !== 'voting') throw new RoomError(409, 'not_voting', 'The room is not voting');
    if (room.deck[room.index] !== gameId) throw new RoomError(409, 'not_current_game', 'That game is not the current card');
    if (vote === 'superlike' && superlikeUsedElsewhere(room, player.id, gameId)) {
      throw new RoomError(409, 'superlike_used', 'You already used your SuperLike in this room');
    }
    if (applyVote(room, player.id, gameId, vote)) {
      if (everyoneVoted(room)) closeCurrentCard(room);
      this.touch(room);
    }
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

  /**
   * Host ends voting before the deck runs out. The open card is discarded (its votes dropped, no
   * result): only cards that actually closed are ranked. undo() reopens that same card.
   */
  finish(code: string, token: string | null): Snapshot {
    const room = this.getRoom(code);
    this.requireHost(room, token);
    if (room.phase !== 'voting') throw new RoomError(409, 'not_voting', 'The room is not voting');
    delete room.votes[room.deck[room.index]];
    room.phase = 'finished';
    // null so clients don't replay the previous card's swipe/match animation.
    room.lastResult = null;
    this.touch(room);
    return toSnapshot(room);
  }

  undo(code: string, token: string | null): Snapshot {
    const room = this.getRoom(code);
    this.requireHost(room, token);
    if (finishedEarly(room)) return this.resumeVoting(room);
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

  /** Undo of an early finish: the card that was open comes back with no votes; closed cards stay closed. */
  private resumeVoting(room: Room): Snapshot {
    room.phase = 'voting';
    room.lastResult = null;
    this.touch(room);
    return toSnapshot(room);
  }

  /** Full snapshot for a member of THIS room (host or player token), the public view for anyone else. */
  view(code: string, token: string | null): Snapshot | PublicRoom {
    const room = this.getRoom(code);
    if (findPlayer(room, token)) return toSnapshot(room);
    return { code: room.code, phase: room.phase, playerCount: room.players.length, maxPlayers: this.limits.maxPlayers };
  }

  /** Id of the player owning the token (401 otherwise). Used to bind SSE stream tickets. */
  playerId(code: string, token: string | null): string {
    return this.requirePlayer(this.getRoom(code), token).id;
  }

  /** False for an unknown/expired room or a player no longer in it (kicked). */
  hasPlayer(code: string, playerId: string): boolean {
    const room = this.rooms.get(code.toUpperCase());
    return Boolean(room && !this.isExpired(room) && room.players.some((p) => p.id === playerId));
  }

  /** Host deletes the room right away: same removal path as expiry (streams get `closed`). */
  close(code: string, token: string | null): void {
    const room = this.getRoom(code);
    this.requireHost(room, token);
    this.remove(room.code, 'closed_by_host');
  }

  /**
   * Live stream count for a room, reported by the SSE hub. Not a mutation: version and lastActivity
   * stay as they are. Unknown codes are ignored (the hub reports 0 while a removed room closes).
   */
  setPresence(code: string, liveConnections: number): void {
    const room = this.rooms.get(code);
    if (!room) return;
    const wasConnected = room.liveConnections > 0 || room.emptySince !== null;
    room.liveConnections = liveConnections;
    if (liveConnections > 0) room.emptySince = null;
    else if (wasConnected && room.emptySince === null) room.emptySince = this.deps.now();
  }

  /** The caller's own vote on the open card: the only way to read it before the card closes. */
  currentVote(code: string, token: string | null): CurrentVote {
    const room = this.getRoom(code);
    const player = this.requirePlayer(room, token);
    const gameId = currentCardId(room);
    return {
      playerId: player.id, gameId, vote: gameId ? room.votes[gameId]?.[player.id] ?? null : null,
      superlikeAvailable: !superlikeUsed(room, player.id),
    };
  }

  /** Removes rooms idle longer than the TTL. Returns the expired codes. */
  expire(): string[] {
    const expired: string[] = [];
    for (const room of this.rooms.values()) {
      const reason = this.expiryReason(room);
      if (reason) expired.push(this.remove(room.code, reason));
    }
    this.pruneCreations();
    return expired;
  }

  private getRoom(rawCode: string): Room {
    const room = this.rooms.get(rawCode.toUpperCase());
    if (!room) throw new RoomError(404, 'room_not_found', 'Room not found');
    const reason = this.expiryReason(room);
    if (reason) {
      this.remove(room.code, reason);
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
    if (this.rooms.size >= this.limits.maxRooms) this.evictIdleLobby();
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
    const player = findPlayer(room, token);
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
    return this.expiryReason(room) !== null;
  }

  private expiryReason(room: Room): ExpireReason | null {
    const now = this.deps.now();
    if (room.emptySince !== null && now - room.emptySince > this.limits.emptyRoomTtlMs) return 'empty';
    const ttl = isLoneHostLobby(room) ? this.limits.lobbyTtlMs : this.limits.ttlMs;
    return now - room.lastActivity > ttl ? 'idle' : null;
  }

  /** Frees one slot by evicting the longest-idle lone-host lobby, if it has been idle long enough. */
  private evictIdleLobby(): void {
    let oldest: Room | undefined;
    for (const room of this.rooms.values()) {
      if (isLoneHostLobby(room) && (!oldest || room.lastActivity < oldest.lastActivity)) oldest = room;
    }
    if (oldest && this.deps.now() - oldest.lastActivity >= this.limits.lobbyEvictIdleMs) this.remove(oldest.code, 'idle');
  }

  private remove(code: string, reason: ExpireReason): string {
    this.rooms.delete(code);
    this.deps.onExpire?.(code, reason);
    return code;
  }

  private pruneCreations(): void {
    const cutoff = this.deps.now() - this.limits.ipWindowMs;
    for (const [ip, times] of this.creationsByIp) {
      if (!times.some((at) => at > cutoff)) this.creationsByIp.delete(ip);
    }
  }
}

/** Finished by the host before the deck ran out: deck[index] is the card that was open (discarded). */
function finishedEarly(room: Room): boolean {
  return room.phase === 'finished' && room.index < room.deck.length;
}

function findPlayer(room: Room, token: string | null): Player | undefined {
  return token ? room.players.find((p) => tokensEqual(p.token, token)) : undefined;
}

function isLoneHostLobby(room: Room): boolean {
  return room.phase === 'lobby' && room.players.length === 1;
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

function isVoteValue(vote: unknown): vote is Vote | null {
  return vote === null || vote === 'like' || vote === 'nope' || vote === 'played' || vote === 'superlike';
}

/** Closed cards are the only ones that can hold a player's frozen superlike besides the open card. */
function superlikeUsedElsewhere(room: Room, playerId: string, openGameId: string): boolean {
  return Object.entries(room.votes).some(([gameId, byPlayer]) => gameId !== openGameId && byPlayer[playerId] === 'superlike');
}

/** A superlike on the open card still counts as used: the player can only free it by changing the vote. */
function superlikeUsed(room: Room, playerId: string): boolean {
  return Object.values(room.votes).some((byPlayer) => byPlayer[playerId] === 'superlike');
}

function everyoneVoted(room: Room): boolean {
  const cardVotes = room.votes[room.deck[room.index]] ?? {};
  return room.players.every((p) => cardVotes[p.id] !== undefined);
}

/** Freezes the open card's tally. playedOut needs a strict majority of the votes CAST (0 votes never qualifies). */
function closeCurrentCard(room: Room): void {
  const gameId = room.deck[room.index];
  const entries = Object.entries(room.votes[gameId] ?? {});
  const cardVotes = entries.map(([, v]) => v);
  const superlikedBy = entries.filter(([, v]) => v === 'superlike').map(([id]) => id).sort();
  const likes = cardVotes.filter((v) => v === 'like' || v === 'superlike').length;
  const nopes = cardVotes.filter((v) => v === 'nope').length;
  const played = cardVotes.filter((v) => v === 'played').length;
  const result: CardResult = {
    gameId, likes, superlikes: superlikedBy.length, superlikedBy, nopes, played, playedOut: played * 2 > likes + nopes + played, match: likes === room.players.length,
  };
  room.history.push(result);
  room.lastResult = result;
  room.index += 1;
  if (room.index >= room.deck.length) room.phase = 'finished';
}

function currentCardId(room: Room): string | null {
  return room.phase === 'voting' ? room.deck[room.index] ?? null : null;
}

function toSnapshot(room: Room): Snapshot {
  const openId = currentCardId(room);
  const openVotes = openId ? room.votes[openId] ?? {} : {};
  return structuredClone({
    code: room.code,
    phase: room.phase,
    players: room.players.map(({ id, name, isHost }) => ({ id, name, isHost })),
    filters: room.filters,
    deck: room.deck,
    index: room.index,
    votes: Object.fromEntries(Object.entries(room.votes).filter(([gameId]) => gameId !== openId)),
    currentVoters: room.players.filter((p) => openVotes[p.id] !== undefined).map((p) => p.id),
    lastResult: room.lastResult,
    results: Object.fromEntries(room.history.map((r) => [r.gameId, r])),
    version: room.version,
  });
}
