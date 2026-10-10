// DEV ONLY. In-memory mock of docs/API.md so the frontend can be built without the real backend.
// Built-ins only. Run: node tools/mock-server.mjs   (PORT=3100 by default)
//
// Extra dev endpoints (not part of the contract):
//   POST /__mock/rooms/:code/bots   { "count": 2, "mode": "like" | "nope" | "random" }  -> fake players that auto-vote
//   POST /__mock/rooms/:code/expire                                                    -> sends `event: closed`
//   POST /__mock/drop                                                                  -> drops every SSE connection
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { GAMES } from '../public/games.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 3100;
const HOST = process.env.HOST || '127.0.0.1';
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const MAX_PLAYERS = 12;
const PING_MS = 25_000;

const STEAM_CDN = 'https://*.steamstatic.com';
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  `img-src 'self' data: ${STEAM_CDN}`,
  `media-src 'self' blob: ${STEAM_CDN}`,
  `connect-src 'self' ${STEAM_CDN}`,
  "worker-src 'self' blob:",
].join('; ');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
};

const rooms = new Map();
const steamCache = new Map();
const ALLOWED_APP_IDS = new Set(GAMES.filter((g) => g.steamId).map((g) => String(g.steamId)));

// ---------- HTTP helpers ----------

class HttpError extends Error {
  constructor(status, code, message = code) { super(message); this.status = status; this.code = code; }
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function readJson(req, limit = 1024) {
  return new Promise((resolve, reject) => {
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
      return reject(new HttpError(415, 'unsupported_media_type', 'Content-Type must be application/json'));
    }
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > limit) { reject(new HttpError(413, 'body_too_large', 'Body too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); } catch { reject(new HttpError(400, 'invalid_json', 'Malformed JSON')); }
    });
  });
}

// ---------- domain ----------

const newCode = () => Array.from({ length: 6 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('');
const newPlayerId = () => `p_${crypto.randomBytes(3).toString('hex')}`;

function validName(raw) {
  const name = typeof raw === 'string' ? raw.trim() : '';
  // eslint-disable-next-line no-control-regex
  if (name.length < 1 || name.length > 16 || /[\u0000-\u001f\u007f]/.test(name)) throw new HttpError(400, 'invalid_name', 'Nombre inválido');
  return name;
}

const openCardId = (room) => (room.phase === 'voting' ? room.deck[room.index] ?? null : null);

// Same privacy rule as the real server: the open card only exposes WHO voted (currentVoters).
function snapshot(room) {
  const { code, phase, filters, deck, index, lastResult, version } = room;
  const players = room.players.map(({ id, name, isHost }) => ({ id, name, isHost }));
  const openId = openCardId(room);
  const openVotes = (openId && room.votes[openId]) || {};
  const votes = Object.fromEntries(Object.entries(room.votes).filter(([gameId]) => gameId !== openId));
  const currentVoters = room.players.filter((p) => openVotes[p.id]).map((p) => p.id);
  const results = Object.fromEntries(room.history.map((r) => [r.gameId, r]));
  return { code, phase, players, filters, deck, index, votes, currentVoters, lastResult, results, version };
}

function ownVote(room, player) {
  const gameId = openCardId(room);
  return { playerId: player.id, gameId, vote: (gameId && room.votes[gameId]?.[player.id]) || null };
}

function getRoom(code) {
  const room = rooms.get(String(code).toUpperCase());
  if (!room) throw new HttpError(404, 'room_not_found', 'La sala no existe');
  return room;
}

function auth(req, room, { host = false } = {}) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const player = room.players.find((p) => p.token === token);
  if (host) {
    if (token === room.hostToken) return room.players.find((p) => p.isHost);
    if (player) throw new HttpError(403, 'not_host', 'Solo el host');
  }
  if (!player) throw new HttpError(401, 'unauthorized', 'Token inválido');
  return player;
}

function changed(room) {
  room.version += 1;
  const data = `event: state\ndata: ${JSON.stringify(snapshot(room))}\n\n`;
  for (const res of room.clients) res.write(data);
  scheduleBots(room);
}

function shuffle(list) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// The mock only knows static prices ("Gratis"); the real backend should use Steam prices.
function buildDeck(filters, playerCount) {
  return shuffle(GAMES.filter((g) => {
    if (!g.platforms.some((p) => filters.platforms.includes(p))) return false;
    if (filters.fitsGroup && g.players[1] < playerCount) return false;
    if (filters.maxPrice === 0 && g.priceLabel !== 'Gratis') return false;
    return true;
  }).map((g) => g.id));
}

function validFilters(filters) {
  const ok = filters && Array.isArray(filters.platforms) && filters.platforms.length > 0
    && (filters.maxPrice === null || (typeof filters.maxPrice === 'number' && filters.maxPrice >= 0))
    && typeof filters.fitsGroup === 'boolean';
  if (!ok) throw new HttpError(400, 'invalid_filters', 'Filtros inválidos');
  return { platforms: filters.platforms, maxPrice: filters.maxPrice, fitsGroup: filters.fitsGroup };
}

// Same rules as the real server: excludeGameIds is optional, max 200, known catalog ids only.
const KNOWN_IDS = new Set(GAMES.map((g) => g.id));
function excludedIds(filters) {
  const ids = filters?.excludeGameIds;
  if (ids === undefined) return new Set();
  if (!Array.isArray(ids) || ids.length > 200 || !ids.every((id) => KNOWN_IDS.has(id))) {
    throw new HttpError(400, 'invalid_filters', 'excludeGameIds inválido');
  }
  return new Set(ids);
}

// skippedBy: "Ya lo jugamos" — votes discarded, never a match.
function closeCard(room, skippedBy = null) {
  const gameId = room.deck[room.index];
  if (skippedBy) delete room.votes[gameId];
  const votes = room.votes[gameId] || {};
  const likes = Object.values(votes).filter((v) => v === 'like').length;
  const nopes = Object.values(votes).filter((v) => v === 'nope').length;
  room.lastResult = skippedBy
    ? { gameId, likes, nopes, match: false, played: true, skippedBy }
    : { gameId, likes, nopes, match: likes === room.players.length };
  room.history.push(room.lastResult);
  room.index += 1;
  if (room.index >= room.deck.length) room.phase = 'finished';
}

function allVoted(room) {
  const votes = room.votes[room.deck[room.index]] || {};
  return room.players.every((p) => votes[p.id]);
}

// ---------- bots (dev helper) ----------

function scheduleBots(room) {
  if (room.phase !== 'voting') return;
  const gameId = room.deck[room.index];
  for (const bot of room.players.filter((p) => p.bot)) {
    const key = `${bot.id}:${gameId}:${room.index}`;
    if (room.botTimers.has(key) || room.votes[gameId]?.[bot.id]) continue;
    room.botTimers.add(key);
    setTimeout(() => botVote(room, bot, gameId), 900 + crypto.randomInt(1500));
  }
}

function botVote(room, bot, gameId) {
  if (room.phase !== 'voting' || room.deck[room.index] !== gameId || !rooms.has(room.code)) return;
  const vote = bot.bot === 'random' ? (crypto.randomInt(2) ? 'like' : 'nope') : bot.bot;
  (room.votes[gameId] ||= {})[bot.id] = vote;
  if (allVoted(room)) closeCard(room);
  changed(room);
}

// ---------- handlers ----------

async function createRoom(req, res) {
  const { hostName } = await readJson(req);
  const name = validName(hostName);
  let code = newCode();
  while (rooms.has(code)) code = newCode();
  const host = { id: newPlayerId(), name, isHost: true, token: crypto.randomUUID() };
  const room = {
    code, phase: 'lobby', players: [host], hostToken: crypto.randomUUID(), filters: null, deck: [], index: 0,
    votes: {}, lastResult: null, history: [], version: 1, clients: new Set(), botTimers: new Set(),
  };
  rooms.set(code, room);
  sendJson(res, 201, { code, hostToken: room.hostToken, playerToken: host.token, playerId: host.id });
}

function addPlayer(room, rawName, bot = null) {
  const name = validName(rawName);
  if (room.phase === 'finished') throw new HttpError(409, 'room_finished', 'Terminó');
  if (room.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) throw new HttpError(409, 'name_taken', 'Nombre en uso');
  if (room.players.length >= MAX_PLAYERS) throw new HttpError(409, 'room_full', 'Sala llena');
  const player = { id: newPlayerId(), name, isHost: false, token: crypto.randomUUID(), bot };
  room.players.push(player);
  return player;
}

async function join(req, res, room) {
  const { name } = await readJson(req);
  const player = addPlayer(room, name);
  changed(room);
  sendJson(res, 201, { playerToken: player.token, playerId: player.id });
}

async function start(req, res, room) {
  const body = await readJson(req, 16 * 1024);
  auth(req, room, { host: true });
  if (room.phase !== 'lobby') throw new HttpError(409, 'already_started', 'Ya empezó');
  const filters = validFilters(body.filters);
  const excluded = excludedIds(body.filters);
  const deck = buildDeck(filters, room.players.length).filter((id) => !excluded.has(id));
  if (!deck.length) throw new HttpError(422, 'empty_deck', 'Ningún juego pasa los filtros');
  Object.assign(room, { phase: 'voting', filters, deck, index: 0, votes: {}, lastResult: null, history: [] });
  changed(room);
  sendJson(res, 200, snapshot(room));
}

async function vote(req, res, room) {
  const body = await readJson(req);
  const player = auth(req, room);
  if (room.phase !== 'voting') throw new HttpError(409, 'not_voting', 'No hay votación');
  if (![ 'like', 'nope', null ].includes(body.vote) || typeof body.gameId !== 'string') throw new HttpError(400, 'invalid_vote', 'Voto inválido');
  if (body.gameId !== room.deck[room.index]) throw new HttpError(409, 'not_current_game', 'No es la tarjeta actual');
  const votes = (room.votes[body.gameId] ||= {});
  if (body.vote === null) delete votes[player.id];
  else votes[player.id] = body.vote;
  if (allVoted(room)) closeCard(room);
  changed(room);
  sendJson(res, 200, { ...snapshot(room), myVote: ownVote(room, player).vote });
}

function me(req, res, room) {
  sendJson(res, 200, ownVote(room, auth(req, room)));
}

async function kick(req, res, room) {
  const { playerId } = await readJson(req);
  auth(req, room, { host: true });
  if (typeof playerId !== 'string' || !playerId || playerId.length > 64) throw new HttpError(400, 'invalid_player', 'Jugador inválido');
  const target = room.players.find((p) => p.id === playerId);
  if (!target) throw new HttpError(404, 'player_not_found', 'No está en la sala');
  if (target.isHost) throw new HttpError(409, 'cannot_kick_host', 'Al host no');
  room.players = room.players.filter((p) => p !== target);
  if (room.phase === 'voting') {
    delete room.votes[room.deck[room.index]]?.[target.id];
    if (allVoted(room)) closeCard(room);
  }
  changed(room);
  sendJson(res, 200, snapshot(room));
}

async function next(req, res, room) {
  await readJson(req);
  auth(req, room, { host: true });
  if (room.phase !== 'voting') throw new HttpError(409, 'not_voting', 'No hay votación');
  closeCard(room);
  changed(room);
  sendJson(res, 200, snapshot(room));
}

async function skip(req, res, room) {
  const body = await readJson(req);
  const player = auth(req, room);
  if (typeof body?.gameId !== 'string' || !body.gameId || body.gameId.length > 64) throw new HttpError(400, 'invalid_game', 'Juego inválido');
  if (room.phase !== 'voting') throw new HttpError(409, 'not_voting', 'No hay votación');
  if (body.gameId !== room.deck[room.index]) throw new HttpError(409, 'not_current_game', 'No es la tarjeta actual');
  closeCard(room, player.id);
  changed(room);
  sendJson(res, 200, snapshot(room));
}

async function undo(req, res, room) {
  await readJson(req);
  auth(req, room, { host: true });
  if (room.phase === 'lobby' || room.index === 0) throw new HttpError(409, 'nothing_to_undo', 'Nada para deshacer');
  room.index -= 1;
  room.history.pop();
  room.phase = 'voting';
  delete room.votes[room.deck[room.index]];
  room.lastResult = null;
  room.botTimers.clear(); // let bots vote again on the reopened card
  changed(room);
  sendJson(res, 200, snapshot(room));
}

function events(req, res, room) {
  if (req.method === 'HEAD') return void res.writeHead(200, { 'Content-Type': 'text/event-stream' }).end();
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write(`event: state\ndata: ${JSON.stringify(snapshot(room))}\n\n`);
  room.clients.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), PING_MS);
  req.on('close', () => { clearInterval(ping); room.clients.delete(res); });
}

// ---------- dev helpers ----------

async function addBots(req, res, room) {
  const { count = 2, mode = 'like' } = await readJson(req);
  const names = ['Bot Juli', 'Bot Fran', 'Bot Mati', 'Bot Caro', 'Bot Nico', 'Bot Sofi'];
  const added = names.filter((n) => !room.players.some((p) => p.name === n)).slice(0, count)
    .map((n) => addPlayer(room, n, ['like', 'nope', 'random'].includes(mode) ? mode : 'like'));
  changed(room);
  sendJson(res, 201, { added: added.map((p) => p.name) });
}

function expire(res, room) {
  for (const client of room.clients) client.end('event: closed\ndata: {}\n\n');
  rooms.delete(room.code);
  sendJson(res, 200, { ok: true });
}

function dropAll(res) {
  let dropped = 0;
  for (const room of rooms.values()) {
    for (const client of room.clients) { client.socket?.destroy(); dropped += 1; }
    room.clients.clear();
  }
  sendJson(res, 200, { dropped });
}

// ---------- steam proxy (same shape as v1 server.js) ----------

function pickMovie(movies = []) {
  const movie = movies.find((m) => m.highlight) || movies[0];
  if (!movie) return null;
  return { name: movie.name, poster: movie.thumbnail, hls: movie.hls_h264 || null, mp4: movie.mp4?.max || movie.mp4?.['480'] || null };
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

async function steam(res, appId) {
  if (!ALLOWED_APP_IDS.has(appId)) throw new HttpError(404, 'unknown_game', 'Juego desconocido');
  if (!steamCache.has(appId)) {
    const url = `https://store.steampowered.com/api/appdetails?appids=${appId}&cc=ar&l=spanish`;
    const upstream = await fetch(url, { signal: AbortSignal.timeout(8000) }).catch(() => null);
    const entry = upstream?.ok ? (await upstream.json())?.[appId] : null;
    if (!entry?.success) throw new HttpError(502, 'steam_unavailable', 'Steam no respondió');
    steamCache.set(appId, toGameDetails(entry.data));
  }
  sendJson(res, 200, steamCache.get(appId));
}

// ---------- static ----------

function serveStatic(res, pathname) {
  const isSpaRoute = pathname === '/' || /^\/r\/[^/]+\/?$/.test(pathname);
  const rel = isSpaRoute ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) return res.writeHead(403).end('Forbidden');
  fs.readFile(filePath, (err, content) => {
    if (err) return res.writeHead(404).end('Not found');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(content);
  });
}

// ---------- router ----------

const ROOM_ROUTES = {
  'GET ': (req, res, room) => sendJson(res, 200, snapshot(room)),
  'POST /join': join,
  'POST /start': start,
  'POST /vote': vote,
  'POST /next': next,
  'POST /undo': undo,
  'POST /skip': skip,
  'POST /kick': kick,
  'GET /me': me,
  'GET /events': events,
  'HEAD /events': events,
};

async function route(req, res, pathname) {
  if (req.method === 'POST' && pathname === '/api/rooms') return createRoom(req, res);
  if (req.method === 'POST' && pathname === '/__mock/drop') return dropAll(res);
  const steamMatch = pathname.match(/^\/api\/steam\/(\d{1,10})$/);
  if (steamMatch && req.method === 'GET') return steam(res, steamMatch[1]);
  if (pathname === '/healthz') return sendJson(res, 200, { ok: true });
  const mock = pathname.match(/^\/__mock\/rooms\/([^/]+)\/(bots|expire)$/);
  if (mock && req.method === 'POST') return mock[2] === 'bots' ? addBots(req, res, getRoom(mock[1])) : expire(res, getRoom(mock[1]));
  const roomMatch = pathname.match(/^\/api\/rooms\/([^/]+)(\/[a-z]+)?$/);
  if (roomMatch) {
    const handler = ROOM_ROUTES[`${req.method} ${roomMatch[2] || ''}`];
    if (!handler) throw new HttpError(405, 'method_not_allowed', 'Método no permitido');
    return handler(req, res, getRoom(roomMatch[1]));
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method_not_allowed', 'Método no permitido');
  serveStatic(res, pathname);
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  try {
    const { pathname } = new URL(req.url, 'http://localhost');
    await route(req, res, pathname);
  } catch (err) {
    if (!(err instanceof HttpError)) console.error('[mock]', err);
    const status = err instanceof HttpError ? err.status : 500;
    if (!res.headersSent) sendJson(res, status, { error: err.code || 'internal', message: err.message });
  }
});

server.listen(PORT, HOST, () => console.log(`[mock] QueJugamos mock API on http://${HOST}:${PORT}`));
