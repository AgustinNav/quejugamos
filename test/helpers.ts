import http from 'node:http';
import net from 'node:net';
import { startServer } from '../src/server.ts';
import type { AppOptions, RunningServer } from '../src/server.ts';

export type TestServer = RunningServer & { logs: string[]; steamCalls: string[]; clock: { t: number } };

/** Steam stub: every app costs USD 9.99, never touches the network. */
function stubFetch(calls: string[]): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const appId = new URL(url).searchParams.get('appids') ?? '';
    const data = { name: `Game ${appId}`, is_free: false, price_overview: { final: 999, currency: 'USD' } };
    return new Response(JSON.stringify({ [appId]: { success: true, data } }), { status: 200 });
  }) as typeof fetch;
}

export async function startTestServer(options: AppOptions = {}): Promise<TestServer> {
  const logs: string[] = [];
  const steamCalls: string[] = [];
  const clock = { t: Date.now() };
  const server = await startServer({
    log: (event, fields = {}, severity = 'INFO') => logs.push(JSON.stringify({ severity, event, ...fields })),
    fetchImpl: stubFetch(steamCalls),
    now: () => clock.t,
    priceTimeoutMs: 500,
    ...options,
    config: { port: 0, host: '127.0.0.1', cacheFile: null, trustedProxyHops: 0, logProxyHeaders: false, ...options.config },
  });
  return Object.assign(server, { logs, steamCalls, clock });
}

export type JsonResponse = { status: number; body: any; headers: Headers };

export async function api(base: string, method: string, path: string, body?: unknown, token?: string): Promise<JsonResponse> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed: unknown = text;
  try { parsed = JSON.parse(text); } catch { /* non-JSON body (static files) */ }
  return { status: res.status, body: parsed, headers: res.headers };
}

export async function rawPost(base: string, path: string, body: string, contentType = 'application/json', token?: string): Promise<JsonResponse> {
  const headers: Record<string, string> = { 'Content-Type': contentType };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(base + path, { method: 'POST', headers, body });
  const text = await res.text();
  let parsed: unknown = text;
  try { parsed = JSON.parse(text); } catch { /* keep text */ }
  return { status: res.status, body: parsed, headers: res.headers };
}

/** Sends a raw HTTP/1.1 request (for URLs and headers fetch() would normalize) and returns the status code. */
export function rawRequest(port: number, request: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(request));
    let data = '';
    socket.setEncoding('latin1');
    socket.on('data', (chunk) => {
      data += chunk;
      const match = /^HTTP\/1\.1 (\d{3})/.exec(data);
      if (match) { socket.destroy(); resolve(Number(match[1])); }
    });
    socket.on('error', reject);
    socket.on('end', () => reject(new Error(`No status line: ${JSON.stringify(data)}`)));
  });
}

export type SseEvent = { event: string; data: string };
export type SseClient = {
  status: number;
  headers: http.IncomingHttpHeaders;
  waitFor: (predicate: (e: SseEvent) => boolean, timeoutMs?: number) => Promise<SseEvent>;
  ended: Promise<void>;
  close: () => void;
};

function parseEvents(buffer: string): { events: SseEvent[]; rest: string } {
  const blocks = buffer.split('\n\n');
  const rest = blocks.pop() ?? '';
  const events = blocks.flatMap((block) => {
    const lines = block.split('\n').filter((l) => !l.startsWith(':'));
    if (lines.length === 0) return [];
    const event = lines.find((l) => l.startsWith('event: '))?.slice(7) ?? 'message';
    const data = lines.filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
    return [{ event, data }];
  });
  return { events, rest };
}

export function openSse(url: string): Promise<SseClient> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers: { Accept: 'text/event-stream' } }, (res) => {
      const seen: SseEvent[] = [];
      const waiters: Array<{ predicate: (e: SseEvent) => boolean; resolve: (e: SseEvent) => void }> = [];
      let buffer = '';
      let endResolve = () => {};
      const ended = new Promise<void>((r) => { endResolve = r; });
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        const parsed = parseEvents(buffer + chunk);
        buffer = parsed.rest;
        for (const e of parsed.events) {
          seen.push(e);
          for (const w of [...waiters]) if (w.predicate(e)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(e); }
        }
      });
      res.on('end', endResolve);
      res.on('close', endResolve);
      const waitFor = (predicate: (e: SseEvent) => boolean, timeoutMs = 2000) => {
        const found = seen.find(predicate);
        if (found) return Promise.resolve(found);
        return new Promise<SseEvent>((ok, fail) => {
          const timer = setTimeout(() => fail(new Error('SSE event timeout')), timeoutMs);
          waiters.push({ predicate, resolve: (e) => { clearTimeout(timer); ok(e); } });
        });
      };
      resolve({ status: res.statusCode ?? 0, headers: res.headers, waitFor, ended, close: () => req.destroy() });
    });
    req.on('error', reject);
  });
}
