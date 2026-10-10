// Zero-dependency server: static files + Steam store proxy (Steam's API has no CORS).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GAMES } from './public/games.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
// Loopback by default: screen-sharing doesn't need LAN exposure. Deploys set HOST=0.0.0.0.
const HOST = process.env.HOST || '127.0.0.1';
const COUNTRY = process.env.STEAM_CC || 'ar';
const PUBLIC_DIR = path.join(ROOT, 'public');
const CACHE_FILE = path.join(ROOT, '.steam-cache.json');
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX_REQUESTS = 120;

// Only catalog games are proxied, so nobody can use us to hammer Steam or bloat the cache.
const ALLOWED_APP_IDS = new Set(GAMES.filter((g) => g.steamId).map((g) => String(g.steamId)));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const STEAM_CDN = 'https://*.steamstatic.com';
const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' https://cdn.jsdelivr.net",
    "style-src 'self' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
    `img-src 'self' data: ${STEAM_CDN}`,
    `media-src 'self' blob: ${STEAM_CDN}`,
    `connect-src 'self' ${STEAM_CDN}`, // hls.js fetches trailer segments via XHR
    "worker-src 'self' blob:",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

const cache = loadCache();
const inFlight = new Map();
const requestCounts = new Map();

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function persistCache() {
  fs.writeFile(CACHE_FILE, JSON.stringify(cache), (err) => {
    if (err) console.error('[cache] write failed:', err.message);
  });
}

function pickMovie(movies = []) {
  const movie = movies.find((m) => m.highlight) || movies[0];
  if (!movie) return null;
  return {
    name: movie.name,
    poster: movie.thumbnail,
    hls: movie.hls_h264 || null,
    mp4: movie.mp4?.max || movie.mp4?.['480'] || null,
  };
}

function toGameDetails(data) {
  return {
    name: data.name,
    isFree: data.is_free,
    price: data.price_overview || null,
    shortDescription: data.short_description,
    header: data.header_image,
    screenshots: (data.screenshots || []).slice(0, 4).map((s) => s.path_full),
    movie: pickMovie(data.movies),
    genres: (data.genres || []).map((g) => g.description),
    categories: (data.categories || []).map((c) => c.description),
    reviews: data.recommendations?.total || null,
    metacritic: data.metacritic?.score || null,
    releaseDate: data.release_date?.date || null,
  };
}

async function requestSteamApp(appId) {
  const url = `https://store.steampowered.com/api/appdetails?appids=${appId}&cc=${COUNTRY}&l=spanish`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Steam responded ${res.status}`);
  const entry = (await res.json())?.[appId];
  if (!entry?.success) throw new Error(`Steam has no data for app ${appId}`);
  const details = toGameDetails(entry.data);
  cache[appId] = { at: Date.now(), details };
  persistCache();
  return details;
}

// Concurrent misses for the same app share one upstream call.
function fetchSteamApp(appId) {
  const cached = cache[appId];
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return Promise.resolve(cached.details);
  if (!inFlight.has(appId)) {
    inFlight.set(appId, requestSteamApp(appId).finally(() => inFlight.delete(appId)));
  }
  return inFlight.get(appId);
}

function isRateLimited(ip) {
  const now = Date.now();
  const entry = requestCounts.get(ip);
  if (!entry || now - entry.start > RATE_WINDOW_MS) {
    requestCounts.set(ip, { start: now, count: 1 });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_MAX_REQUESTS;
}

function pruneRateLimits() {
  const now = Date.now();
  for (const [ip, entry] of requestCounts) {
    if (now - entry.start > RATE_WINDOW_MS) requestCounts.delete(ip);
  }
}
setInterval(pruneRateLimits, RATE_WINDOW_MS).unref();

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

async function handleSteam(req, res, appId) {
  if (isRateLimited(req.socket.remoteAddress)) {
    res.setHeader('Retry-After', String(RATE_WINDOW_MS / 1000));
    return sendJson(res, 429, { error: 'Too many requests' });
  }
  if (!ALLOWED_APP_IDS.has(appId)) return sendJson(res, 404, { error: 'Unknown game' });
  try {
    sendJson(res, 200, await fetchSteamApp(appId));
  } catch (err) {
    const stale = cache[appId]?.details;
    console.warn(`[steam] ${appId}: ${err.message}${stale ? ' (serving stale cache)' : ''}`);
    if (stale) return sendJson(res, 200, { ...stale, stale: true });
    sendJson(res, 502, { error: 'Steam unavailable' });
  }
}

function decodePath(urlPath) {
  try {
    return decodeURIComponent(urlPath);
  } catch {
    return null; // Malformed escapes (e.g. "%E0%A4%A") would otherwise crash the process.
  }
}

function serveStatic(res, urlPath) {
  const decoded = urlPath === '/' ? '/index.html' : decodePath(urlPath);
  if (decoded === null) {
    res.writeHead(400).end('Bad request');
    return;
  }
  const filePath = path.normalize(path.join(PUBLIC_DIR, decoded.replace(/^\/+/, '')));
  // Trailing separator so a sibling like "public-secret/" can't pass the prefix check.
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404).end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(content);
  });
}

function parsePathname(rawUrl) {
  try {
    // Fixed base: the Host header is client-controlled and new URL() throws on garbage.
    return new URL(rawUrl, 'http://localhost').pathname;
  } catch {
    return null;
  }
}

const server = http.createServer((req, res) => {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end('Method not allowed');
    return;
  }
  const pathname = parsePathname(req.url);
  if (pathname === null) {
    res.writeHead(400).end('Bad request');
    return;
  }
  const steamMatch = pathname.match(/^\/api\/steam\/(\d{1,10})$/);
  if (steamMatch) return handleSteam(req, res, steamMatch[1]);
  serveStatic(res, pathname);
});

server.listen(PORT, HOST, () => {
  console.log(`🎮 GameMatch corriendo en http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}  (precios Steam región: ${COUNTRY.toUpperCase()})`);
});
