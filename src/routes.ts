// API handlers. Thin: parse input, call the domain, broadcast, log, respond.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { normalizeRef, parseViaGuest } from './acquisition.ts';
import { buildDeck, parseExcludeGameIds, parseFilters } from './deck.ts';
import type { CatalogGame } from './deck.ts';
import { bearerToken, readJsonBody, sendError, sendJson } from './http.ts';
import type { Logger } from './log.ts';
import type { RoomStore, Snapshot } from './rooms.ts';
import type { SseHub } from './sse.ts';

// Headers-only answer for HEAD on the events path (see roomEvents).
const SSE_HEAD_HEADERS = { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform' };
// start may carry up to 200 excludeGameIds, which don't fit in the default 1 KB body.
const START_BODY_BYTES = 16 * 1024;
import type { SteamClient } from './steam.ts';

export type ApiDeps = {
  store: RoomStore;
  hub: SseHub;
  steam: SteamClient;
  log: Logger;
  games: readonly CatalogGame[];
  platforms: readonly string[];
  randomInt: (maxExclusive: number) => number;
  priceTimeoutMs: number;
};

export type RouteContext = { req: IncomingMessage; res: ServerResponse; ip: string; code: string; appId: string };
export type Handler = (deps: ApiDeps, ctx: RouteContext) => Promise<void> | void;

function field(body: unknown, key: string): unknown {
  return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>)[key] : undefined;
}

/** Broadcasts a change and logs the closed card when the mutation advanced the deck. */
function publish(deps: ApiDeps, before: Snapshot, after: Snapshot): void {
  if (after.version === before.version) return;
  deps.hub.broadcast(after.code, after);
  if (after.lastResult && after.index > before.index) {
    const { gameId, likes, nopes, match, played } = after.lastResult;
    const finished = after.phase === 'finished';
    if (played) return deps.log('card_skipped', { roomCode: after.code, gameId, finished });
    deps.log('card_closed', { roomCode: after.code, gameId, likes, nopes, match, finished });
  }
}

export const createRoom: Handler = async (deps, { req, res, ip }) => {
  const body = await readJsonBody(req);
  // Validated before creating anything: a bad field must not consume the per-client room quota.
  const ref = normalizeRef(field(body, 'ref'));
  const viaGuest = parseViaGuest(field(body, 'viaGuest'));
  const created = deps.store.create(field(body, 'hostName'), ip);
  deps.log('room_created', { roomCode: created.code, liveRooms: deps.store.size, ref, viaGuest });
  sendJson(res, 201, created);
};

export const getRoom: Handler = (deps, { res, code }) => {
  sendJson(res, 200, deps.store.snapshot(code));
};

export const joinRoom: Handler = async (deps, { req, res, code }) => {
  const body = await readJsonBody(req);
  const { playerToken, playerId, snapshot } = deps.store.join(code, field(body, 'name'));
  deps.hub.broadcast(snapshot.code, snapshot);
  deps.log('player_joined', { roomCode: snapshot.code, playerId, players: snapshot.players.length, phase: snapshot.phase });
  sendJson(res, 201, { playerToken, playerId });
};

export const startRoom: Handler = async (deps, { req, res, code }) => {
  const body = await readJsonBody(req, START_BODY_BYTES);
  const token = bearerToken(req);
  deps.store.assertCanStart(code, token);
  const filters = parseFilters(field(body, 'filters'), deps.platforms);
  const excluded = new Set(parseExcludeGameIds(field(body, 'filters'), new Set(deps.games.map((g) => g.id))));
  const prices = await deps.steam.getCatalogPrices(deps.priceTimeoutMs);
  const snapshot = deps.store.start(code, token, filters, (f, playerCount) =>
    buildDeck(deps.games, f, playerCount, prices, deps.randomInt, excluded));
  deps.hub.broadcast(snapshot.code, snapshot);
  deps.log('game_started', {
    roomCode: snapshot.code, players: snapshot.players.length, deckSize: snapshot.deck.length, filters, excludedGames: excluded.size,
  });
  sendJson(res, 200, snapshot);
};

export const voteRoom: Handler = async (deps, { req, res, code }) => {
  const body = await readJsonBody(req);
  const before = deps.store.snapshot(code);
  const token = bearerToken(req);
  const after = deps.store.vote(code, token, field(body, 'gameId'), field(body, 'vote'));
  publish(deps, before, after);
  // Snapshots hide open-card votes, so the voter gets their own back here (null once the card closed).
  sendJson(res, 200, { ...after, myVote: deps.store.currentVote(code, token).vote });
};

export const myVote: Handler = (deps, { req, res, code }) => {
  sendJson(res, 200, deps.store.currentVote(code, bearerToken(req)));
};

export const nextCard: Handler = async (deps, { req, res, code }) => {
  await readJsonBody(req);
  const before = deps.store.snapshot(code);
  const after = deps.store.next(code, bearerToken(req));
  publish(deps, before, after);
  sendJson(res, 200, after);
};

export const skipCard: Handler = async (deps, { req, res, code }) => {
  const body = await readJsonBody(req);
  const before = deps.store.snapshot(code);
  const after = deps.store.skip(code, bearerToken(req), field(body, 'gameId'));
  publish(deps, before, after);
  sendJson(res, 200, after);
};

export const undoCard: Handler = async (deps, { req, res, code }) => {
  await readJsonBody(req);
  const before = deps.store.snapshot(code);
  const after = deps.store.undo(code, bearerToken(req));
  publish(deps, before, after);
  // Same index as before = it undid an early finish (the discarded card came back), not a closed card.
  const afterEarlyFinish = before.phase === 'finished' && before.index === after.index;
  deps.log('card_reopened', { roomCode: after.code, gameId: after.deck[after.index], afterEarlyFinish });
  sendJson(res, 200, after);
};

export const finishRoom: Handler = async (deps, { req, res, code }) => {
  await readJsonBody(req);
  const before = deps.store.snapshot(code);
  const after = deps.store.finish(code, bearerToken(req));
  publish(deps, before, after);
  // index = cards that closed (voted or skipped); the open one was discarded.
  deps.log('game_finished_early', { roomCode: after.code, closedCards: after.index, deckSize: after.deck.length });
  sendJson(res, 200, after);
};

export const kickPlayer: Handler = async (deps, { req, res, code }) => {
  const body = await readJsonBody(req);
  const playerId = field(body, 'playerId');
  const before = deps.store.snapshot(code);
  const after = deps.store.kick(code, bearerToken(req), playerId);
  deps.log('player_kicked', { roomCode: after.code, playerId, players: after.players.length, phase: after.phase });
  publish(deps, before, after);
  sendJson(res, 200, after);
};

export const roomEvents: Handler = (deps, { req, res, code, ip }) => {
  const snapshot = deps.store.snapshot(code);
  // HEAD must not hold a stream slot open: answer the headers and end.
  if (req.method === 'HEAD') return void res.writeHead(200, SSE_HEAD_HEADERS).end();
  if (!deps.hub.connect(snapshot.code, res, snapshot, ip)) {
    sendError(res, 503, 'capacity', 'Too many live connections, try again later');
  }
};

export const steamDetails: Handler = async (deps, { res, appId }) => {
  if (!deps.steam.isAllowed(appId)) return sendError(res, 404, 'unknown_game', 'Unknown game');
  try {
    sendJson(res, 200, await deps.steam.getDetails(appId));
  } catch (err) {
    const stale = deps.steam.staleDetails(appId);
    deps.log('steam_fetch_failed', { appId, reason: (err as Error).message, servedStale: Boolean(stale) }, 'WARNING');
    if (stale) return sendJson(res, 200, { ...stale, stale: true });
    sendError(res, 502, 'steam_unavailable', 'Steam is unavailable, try again later');
  }
};
