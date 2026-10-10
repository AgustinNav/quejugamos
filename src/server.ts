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
import { HttpError, clientIp, createRateLimiter, forwardedFor, parsePathname, safeDecode, sendError, sendJson } from './http.ts';
import { createLogger } from './log.ts';
import type { Logger } from './log.ts';
import { DEFAULT_LIMITS, RoomError, RoomStore } from './rooms.ts';
import type { RoomLimits } from './rooms.ts';
import * as routes from './routes.ts';
import type { ApiDeps, Handler, RouteContext } from './routes.ts';
import { SseHub } from './sse.ts';
import type { SseHubOptions } from './sse.ts';
import { SteamClient } from './steam.ts';

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
    "script-src 'self' https://cdn.jsdelivr.net", // QR lib is vendored under /vendor
    "style-src 'self' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
    `img-src 'self' data: ${STEAM_CDN}`,
    `media-src 'self' blob: ${STEAM_CDN}`,
    `connect-src 'self' ${STEAM_CDN}`, // 'self' covers SSE; hls.js fetches trailer segments via XHR
    "worker-src 'self' blob:",
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
const EXPIRY_SWEEP_MS = 60_000;
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
  { method: 'POST', pattern: /^\/api\/rooms\/([^/]+)\/undo$/, handler: routes.undoCard },
  { method: 'GET', pattern: /^\/api\/rooms\/([^/]+)\/events$/, handler: routes.roomEvents },
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
};

export type App = {
  server: http.Server;
  store: RoomStore;
  hub: SseHub;
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
  if (decoded === null) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Bad request');
    return;
  }
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
  if (isRoom && !ROOM_CODE.test(params[0])) return sendError(res, 404, 'room_not_found', 'Room not found');
  const ctx: RouteContext = { req, res, ip, code: isRoom ? params[0] : '', appId: isRoom ? '' : params[0] ?? '' };
  return route.handler(deps, ctx);
}

function createHandler(deps: ApiDeps, config: AppConfig) {
  const limiter = createRateLimiter(API_RATE_WINDOW_MS, API_RATE_MAX);
  setInterval(() => limiter.prune(), API_RATE_WINDOW_MS).unref();
  return async (req: IncomingMessage, res: ServerResponse) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    const host = req.headers.host;
    if (host !== undefined && !VALID_HOST.test(host)) return sendError(res, 400, 'bad_request', 'Invalid Host header');
    const pathname = parsePathname(req.url);
    if (pathname === null) return sendError(res, 400, 'bad_request', 'Malformed URL');
    if (pathname === '/healthz') return sendJson(res, 200, { ok: true });
    if (pathname.startsWith('/api/')) {
      const ip = clientIp(req, config.trustedProxyHops);
      if (config.logProxyHeaders && req.method === 'POST' && pathname === '/api/rooms') {
        log('proxy_headers', { forwardedFor: forwardedFor(req), socketIp: req.socket.remoteAddress, resolvedIp: ip });
      }
      if (limiter.hit(ip)) return sendError(res, 429, 'rate_limited', 'Too many requests', { 'Retry-After': '60' });
      return routeApi(deps, req, res, pathname, ip);
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
  const server = http.createServer((req, res) => {
    // Promise.resolve().then() also turns synchronous throws into rejections, so nothing escapes.
    Promise.resolve().then(() => handle(req, res)).catch((err) => handleError(err, res, log));
  });
  const sweep = setInterval(() => deps.store.expire(), EXPIRY_SWEEP_MS);
  sweep.unref();
  const close = () => new Promise<void>((resolve) => {
    clearInterval(sweep);
    deps.hub.closeAll();
    server.close(() => resolve());
    server.closeIdleConnections();
    setTimeout(() => server.closeAllConnections(), 2000).unref();
  });
  return { server, store: deps.store, hub: deps.hub, config, close };
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
