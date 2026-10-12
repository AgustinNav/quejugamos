// ¿Qué Jugamos? server: static files, rooms API with SSE, Steam proxy. Zero runtime dependencies.
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { randomInt, randomUUID } from 'node:crypto';
import { GAMES, PLATFORMS } from '../public/games.js';
import { loadConfig } from './config.ts';
import type { AppConfig } from './config.ts';
import { HttpError, clientIp, createRateLimiter, forwardedFor, parsePathname, rateLimitKey, safeDecode, sendError, sendJson } from './http.ts';
import type { RateLimiter } from './http.ts';
import { createLogger } from './log.ts';
import type { Logger } from './log.ts';
import { DEFAULT_LIMITS, RoomError, RoomStore } from './rooms.ts';
import type { RoomLimits } from './rooms.ts';
import * as routes from './routes.ts';
import type { ApiDeps, Handler, RouteContext } from './routes.ts';
import { SseHub } from './sse.ts';
import type { SseHubOptions } from './sse.ts';
import { SteamClient } from './steam.ts';
import type { UpstreamQueue } from './upstream-queue.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const STEAM_CDN = 'https://*.steamstatic.com';
const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'", // QR lib and hls.js are vendored under /vendor
    "style-src 'self' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
    `img-src 'self' data: ${STEAM_CDN}`,
    `media-src 'self' blob: ${STEAM_CDN}`,
    `connect-src 'self' ${STEAM_CDN}`, // 'self' covers SSE; hls.js fetches trailer segments via XHR
    "worker-src 'self' blob:", // hls.js injects its transmuxer worker from a Blob URL
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

const API_RATE_WINDOW_MS = 60_000;
// Sized for a whole party behind one home NAT: 12 phones voting plus Steam detail lookups.
const API_RATE_MAX = 600;
// Unknown room codes per client per window. A real user mistypes a code a handful of times.
const ROOM_MISS_MAX = 20;
const HSTS = 'max-age=15552000; includeSubDomains';
const EXPIRY_SWEEP_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
// Above the SSE global cap (2000) so plain requests still get through when streams are maxed out.
const MAX_CONNECTIONS = 3000;
const VALID_HOST = /^(?:[A-Za-z0-9.-]{1,253}|\[[0-9A-Fa-f:.]{2,45}\])(?::\d{1,5})?$/;
const ROOM_CODE = /^[A-Za-z0-9]{6}$/;

type Route = { method: 'GET' | 'POST'; pattern: RegExp; handler: Handler };

const ROUTES: Route[] = [
  { method: 'POST', pattern: /^\/api\/rooms$/, handler: routes.createRoom },
  { method: 'GET', pattern: /^\/api\/rooms\/([^/]+)$/, handler: routes.getRoom },
  { method: 'POST', pattern: /^\/api\/rooms\/([^/]+)\/join$/, handler: routes.joinRoom },
  { method: 'POST', pattern: /^\/api\/rooms\/([^/]+)\/start$/, handler: routes.startRoom },
  { method: 'POST', pattern: /^\/api\/rooms\/([^/]+)\/vote$/, handler: routes.voteRoom },
  { method: 'POST', pattern: /^\/api\/rooms\/([^/]+)\/next$/, handler: routes.nextCard },
  { method: 'POST', pattern: /^\/api\/rooms\/([^/]+)\/skip$/, handler: routes.skipCard },
  { method: 'POST', pattern: /^\/api\/rooms\/([^/]+)\/undo$/, handler: routes.undoCard },
  { method: 'POST', pattern: /^\/api\/rooms\/([^/]+)\/finish$/, handler: routes.finishRoom },
  { method: 'POST', pattern: /^\/api\/rooms\/([^/]+)\/kick$/, handler: routes.kickPlayer },
  { method: 'GET', pattern: /^\/api\/rooms\/([^/]+)\/events$/, handler: routes.roomEvents },
  { method: 'GET', pattern: /^\/api\/rooms\/([^/]+)\/me$/, handler: routes.myVote },
  { method: 'GET', pattern: /^\/api\/steam\/(\d{1,10})$/, handler: routes.steamDetails },
];

export type AppOptions = {
  config?: Partial<AppConfig>;
  log?: Logger;
  fetchImpl?: typeof fetch;
  now?: () => number;
  limits?: Partial<RoomLimits>;
  sse?: SseHubOptions;
  priceTimeoutMs?: number;
  requestTimeoutMs?: number;
  steamQueue?: UpstreamQueue;
};

export type App = {
  server: http.Server;
  store: RoomStore;
  hub: SseHub;
  steam: SteamClient;
  config: AppConfig;
  close: () => Promise<void>;
};

function buildDeps(config: AppConfig, options: AppOptions, log: Logger): ApiDeps {
  const now = options.now ?? Date.now;
  const hub = new SseHub(options.sse);
  const onExpire = (code: string) => {
    hub.close(code);
    log('room_expired', { roomCode: code });
  };
  const store = new RoomStore({ now, randomInt, uuid: randomUUID, onExpire }, { ...DEFAULT_LIMITS, ...options.limits });
  const steam = new SteamClient({
    games: GAMES, country: config.country, fetchImpl: options.fetchImpl, cacheFile: config.cacheFile, now, log,
    queue: options.steamQueue,
  });
  return {
    store, hub, steam, log, games: GAMES, platforms: PLATFORMS, randomInt, priceTimeoutMs: options.priceTimeoutMs ?? 4000,
  };
}

function serveFile(req: IncomingMessage, res: ServerResponse, filePath: string): void {
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(req.method === 'HEAD' ? undefined : content);
  });
}

function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string, publicDir: string): void {
  // SPA fallback: room links are rendered client-side.
  const isRoomPage = /^\/r\/[^/]+\/?$/.test(pathname);
  const decoded = pathname === '/' || isRoomPage ? '/index.html' : safeDecode(pathname);
  // fs throws synchronously on a NUL byte in the path, which would surface as a 500.
  if (decoded === null || decoded.includes('\0')) return sendError(res, 400, 'bad_request', 'Malformed URL');
  const filePath = path.normalize(path.join(publicDir, decoded.replace(/^\/+/, '')));
  // Trailing separator so a sibling like "public-secret/" can't pass the prefix check.
  if (!filePath.startsWith(publicDir + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Forbidden');
    return;
  }
  serveFile(req, res, filePath);
}

function handleError(err: unknown, res: ServerResponse, log: Logger): void {
  if (err instanceof RoomError || err instanceof HttpError) {
    if (res.headersSent) return void res.destroy();
    // The body of an oversized request may still be arriving: don't reuse the connection.
    const headers: Record<string, string> = err.status === 413 ? { Connection: 'close' } : {};
    return sendError(res, err.status, err.code, err.message, headers);
  }
  log('error', { reason: (err as Error)?.message, stack: (err as Error)?.stack }, 'ERROR');
  if (res.headersSent) return void res.destroy();
  sendError(res, 500, 'internal', 'Unexpected server error');
}

// Every path maps to at most one route, so a path match with the wrong method is a 405.
function findRoute(pathname: string): { route?: Route; params?: string[] } {
  for (const route of ROUTES) {
    const match = route.pattern.exec(pathname);
    if (match) return { route, params: match.slice(1) };
  }
  return {};
}

function routeApi(deps: ApiDeps, req: IncomingMessage, res: ServerResponse, pathname: string, ip: string): Promise<void> | void {
  const { route, params = [] } = findRoute(pathname);
  if (!route) return sendError(res, 404, 'not_found', 'Unknown API endpoint');
  const method = req.method === 'HEAD' ? 'GET' : req.method;
  if (method !== route.method) {
    return sendError(res, 405, 'method_not_allowed', `Use ${route.method}`, { Allow: route.method === 'GET' ? 'GET, HEAD' : route.method });
  }
  const isRoom = pathname.startsWith('/api/rooms/');
  if (isRoom && !ROOM_CODE.test(params[0])) throw new RoomError(404, 'room_not_found', 'Room not found');
  const ctx: RouteContext = { req, res, ip, code: isRoom ? params[0] : '', appId: isRoom ? '' : params[0] ?? '' };
  return route.handler(deps, ctx);
}

function roomMissesExceeded(): HttpError {
  return new HttpError(429, 'rate_limited', 'Too many unknown room codes, try again in a minute');
}

/**
 * Guessing room codes shows up as a burst of room_not_found. Past the limit every room lookup from
 * that client is refused, hits included: otherwise a 200 among the 429s would still reveal a code.
 */
async function limitRoomMisses(misses: RateLimiter, ip: string, run: () => Promise<void> | void): Promise<void> {
  if (misses.isLimited(ip)) throw roomMissesExceeded();
  try {
    await run();
  } catch (err) {
    if (err instanceof RoomError && err.code === 'room_not_found' && misses.hit(ip)) throw roomMissesExceeded();
    throw err;
  }
}

/** Only behind a trusted proxy: there X-Forwarded-Proto tells whether the client used HTTPS. */
function arrivedOverHttps(req: IncomingMessage, trustedProxyHops: number): boolean {
  if (trustedProxyHops <= 0) return false;
  const header = req.headers['x-forwarded-proto'];
  const value = Array.isArray(header) ? header.join(',') : header ?? '';
  return value.split(',').at(-1)?.trim().toLowerCase() === 'https';
}

function createHandler(deps: ApiDeps, config: AppConfig) {
  const limiter = createRateLimiter(API_RATE_WINDOW_MS, API_RATE_MAX);
  const roomMisses = createRateLimiter(API_RATE_WINDOW_MS, ROOM_MISS_MAX);
  setInterval(() => { limiter.prune(); roomMisses.prune(); }, API_RATE_WINDOW_MS).unref();
  return async (req: IncomingMessage, res: ServerResponse) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    if (arrivedOverHttps(req, config.trustedProxyHops)) res.setHeader('Strict-Transport-Security', HSTS);
    const host = req.headers.host;
    if (host !== undefined && !VALID_HOST.test(host)) return sendError(res, 400, 'bad_request', 'Invalid Host header');
    const pathname = parsePathname(req.url);
    if (pathname === null) return sendError(res, 400, 'bad_request', 'Malformed URL');
    if (pathname === '/healthz') return sendJson(res, 200, { ok: true });
    if (pathname.startsWith('/api/')) {
      const resolvedIp = clientIp(req, config.trustedProxyHops);
      const ip = rateLimitKey(resolvedIp);
      if (config.logProxyHeaders && req.method === 'POST' && pathname === '/api/rooms') {
        deps.log('proxy_headers', { forwardedFor: forwardedFor(req), socketIp: req.socket.remoteAddress, resolvedIp, rateKey: ip });
      }
      if (limiter.hit(ip)) return sendError(res, 429, 'rate_limited', 'Too many requests', { 'Retry-After': '60' });
      if (!pathname.startsWith('/api/rooms/')) return routeApi(deps, req, res, pathname, ip);
      return limitRoomMisses(roomMisses, ip, () => routeApi(deps, req, res, pathname, ip));
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return void res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' }).end('Method not allowed');
    }
    serveStatic(req, res, pathname, config.publicDir);
  };
}

export function createApp(options: AppOptions = {}): App {
  const config = { ...loadConfig(), ...options.config };
  const log = options.log ?? createLogger();
  const deps = buildDeps(config, options, log);
  const handle = createHandler(deps, config);
  const requestTimeout = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const server = http.createServer({
    // Slowloris: a request must be fully received (headers and body) within requestTimeout.
    // Node stops timing a request once it is received, so long-lived SSE responses are unaffected.
    requestTimeout,
    headersTimeout: requestTimeout,
    // Node's default check runs every 30 s, which would stretch a 10 s timeout up to 40 s.
    connectionsCheckingInterval: Math.min(1000, Math.max(50, Math.floor(requestTimeout / 4))),
  }, (req, res) => {
    // Promise.resolve().then() also turns synchronous throws into rejections, so nothing escapes.
    Promise.resolve().then(() => handle(req, res)).catch((err) => handleError(err, res, log));
  });
  server.maxConnections = MAX_CONNECTIONS;
  const sweep = setInterval(() => deps.store.expire(), EXPIRY_SWEEP_MS);
  sweep.unref();
  const close = () => new Promise<void>((resolve) => {
    clearInterval(sweep);
    deps.hub.closeAll();
    server.close(() => resolve());
    server.closeIdleConnections();
    setTimeout(() => server.closeAllConnections(), 2000).unref();
  });
  return { server, store: deps.store, hub: deps.hub, steam: deps.steam, config, close };
}

export type RunningServer = App & { port: number; url: string };

/** Starts listening. Pass `config.port: 0` for an ephemeral port (tests). */
export function startServer(options: AppOptions = {}): Promise<RunningServer> {
  const app = createApp(options);
  return new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(app.config.port, app.config.host, () => {
      const { port } = app.server.address() as AddressInfo;
      const shownHost = app.config.host === '0.0.0.0' ? 'localhost' : app.config.host;
      resolve({ ...app, port, url: `http://${shownHost}:${port}` });
    });
  });
}

async function main(): Promise<void> {
  const log = createLogger();
  process.on('uncaughtException', (err) => {
    log('error', { reason: err.message, stack: err.stack, fatal: true }, 'ERROR');
    process.exit(1);
  });
  const app = await startServer({ log });
  log('server_started', { url: app.url, steamCountry: app.config.country, trustedProxyHops: app.config.trustedProxyHops });
  // Render's disk is ephemeral: every deploy/spin-up starts with an empty Steam cache.
  app.steam.warmCache();
  const shutdown = (signal: string) => {
    log('server_stopping', { signal, sseConnections: app.hub.connectionCount() });
    setTimeout(() => process.exit(0), 8000).unref();
    app.close().then(() => process.exit(0));
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(JSON.stringify({ severity: 'ERROR', message: 'startup_failed', reason: err.message }));
    process.exit(1);
  });
}
