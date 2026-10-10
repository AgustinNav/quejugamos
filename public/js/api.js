// Client for the API contract in docs/API.md.

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

async function request(method, path, { body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (err) {
    throw new ApiError(0, 'network', err.message);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.error || fallbackCode(res.status), data?.message);
  return data;
}

function fallbackCode(status) {
  if (status === 401) return 'unauthorized';
  if (status === 404) return 'room_not_found';
  if (status === 429) return 'rate_limited';
  return `http_${status}`;
}

const roomPath = (code, suffix = '') => `/api/rooms/${encodeURIComponent(code)}${suffix}`;

export const api = {
  createRoom: (hostName) => request('POST', '/api/rooms', { body: { hostName } }),
  getRoom: (code) => request('GET', roomPath(code)),
  join: (code, name) => request('POST', roomPath(code, '/join'), { body: { name } }),
  start: (code, token, filters) => request('POST', roomPath(code, '/start'), { body: { filters }, token }),
  vote: (code, token, gameId, vote) => request('POST', roomPath(code, '/vote'), { body: { gameId, vote }, token }),
  next: (code, token) => request('POST', roomPath(code, '/next'), { body: {}, token }),
  undo: (code, token) => request('POST', roomPath(code, '/undo'), { body: {}, token }),
  kick: (code, token, playerId) => request('POST', roomPath(code, '/kick'), { body: { playerId }, token }),
  me: (code, token) => request('GET', roomPath(code, '/me'), { token }),
  steam: (appId) => request('GET', `/api/steam/${encodeURIComponent(appId)}`),
};

export function openEvents(code) {
  return new EventSource(roomPath(code, '/events'));
}
