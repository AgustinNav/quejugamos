// API handlers. Thin: parse input, call the domain, broadcast, log, respond.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildDeck, parseFilters } from './deck.ts';
import type { CatalogGame } from './deck.ts';
import { bearerToken, readJsonBody, sendError, sendJson } from './http.ts';
import type { Logger } from './log.ts';
import type { RoomStore, Snapshot } from './rooms.ts';
import type { SseHub } from './sse.ts';
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
    const { gameId, likes, nopes, match } = after.lastResult;
    deps.log('card_closed', { roomCode: after.code, gameId, likes, nopes, match, finished: after.phase === 'finished' });
  }
}

export const createRoom: Handler = async (deps, { req, res, ip }) => {
  const body = await readJsonBody(req);
  const created = deps.store.create(field(body, 'hostName'), ip);
  deps.log('room_created', { roomCode: created.code, liveRooms: deps.store.size });
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
  const body = await readJsonBody(req);
  const token = bearerToken(req);
  deps.store.assertCanStart(code, token);
  const filters = parseFilters(field(body, 'filters'), deps.platforms);
  const prices = await deps.steam.getCatalogPrices(deps.priceTimeoutMs);
  const snapshot = deps.store.start(code, token, filters, (f, playerCount) =>
    buildDeck(deps.games, f, playerCount, prices, deps.randomInt));
  deps.hub.broadcast(snapshot.code, snapshot);
  deps.log('game_started', { roomCode: snapshot.code, players: snapshot.players.length, deckSize: snapshot.deck.length, filters });
  sendJson(res, 200, snapshot);
};

export const voteRoom: Handler = async (deps, { req, res, code }) => {
  const body = await readJsonBody(req);
  const before = deps.store.snapshot(code);
  const after = deps.store.vote(code, bearerToken(req), field(body, 'gameId'), field(body, 'vote'));
  publish(deps, before, after);
  sendJson(res, 200, after);
};

export const nextCard: Handler = async (deps, { req, res, code }) => {
  await readJsonBody(req);
  const before = deps.store.snapshot(code);
  const after = deps.store.next(code, bearerToken(req));
  publish(deps, before, after);
  sendJson(res, 200, after);
};

export const undoCard: Handler = async (deps, { req, res, code }) => {
  await readJsonBody(req);
  const before = deps.store.snapshot(code);
  const after = deps.store.undo(code, bearerToken(req));
  publish(deps, before, after);
  deps.log('card_reopened', { roomCode: after.code, gameId: after.deck[after.index] });
  sendJson(res, 200, after);
};

export const roomEvents: Handler = (deps, { res, code }) => {
  const snapshot = deps.store.snapshot(code);
  if (!deps.hub.connect(snapshot.code, res, snapshot)) {
    sendError(res, 503, 'capacity', 'Too many live connections for this room');
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
