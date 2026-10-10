// HTTP helpers. Every parse of client input here fails with an HttpError (4xx), never an uncaught throw.
import type { IncomingMessage, ServerResponse } from 'node:http';

export const MAX_BODY_BYTES = 1024;

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function sendJson(res: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

export function sendError(res: ServerResponse, status: number, code: string, message: string, headers: Record<string, string> = {}): void {
  sendJson(res, status, { error: code, message }, headers);
}

function isJsonContentType(header: string | undefined): boolean {
  return (header ?? '').split(';')[0].trim().toLowerCase() === 'application/json';
}

function tooLarge(): HttpError {
  return new HttpError(413, 'body_too_large', `Request body must be at most ${MAX_BODY_BYTES} bytes`);
}

function collectBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        req.removeAllListeners('data');
        req.resume(); // Drain the rest without buffering it.
        reject(tooLarge());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => reject(new HttpError(400, 'bad_request', 'Could not read the request body')));
  });
}

/** Reads a JSON body: Content-Type must be application/json, max 1 KB, empty body counts as {}. */
export async function readJsonBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<unknown> {
  if (!isJsonContentType(req.headers['content-type'])) {
    throw new HttpError(415, 'unsupported_media_type', 'Content-Type must be application/json');
  }
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) {
    req.resume();
    throw tooLarge();
  }
  const raw = await collectBody(req, limit);
  if (raw.trim() === '') return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'invalid_json', 'Request body is not valid JSON');
  }
}

export function bearerToken(req: IncomingMessage): string | null {
  const match = /^Bearer ([A-Za-z0-9._~+/=-]{1,200})$/i.exec(req.headers.authorization ?? '');
  return match ? match[1] : null;
}

/**
 * Client IP for rate limiting.
 *
 * With TRUST_PROXY=1 we use the RIGHTMOST X-Forwarded-For entry. Google's front end *appends* the
 * address it saw to whatever the client sent, and "does not verify any IP addresses that precede"
 * the ones it adds (https://docs.cloud.google.com/load-balancing/docs/https, "X-Forwarded-For header").
 * The leftmost entry ("generally the IP of the client",
 * https://docs.cloud.google.com/functions/docs/reference/headers) is therefore client-controlled and
 * trivially spoofable. For direct *.run.app ingress the rightmost entry is the client address
 * appended by Google. Cloud Run's own docs don't spell out the run.app format, so confirm it by
 * logging the header once after the first deploy. If an external Application Load Balancer is put in front, the rightmost
 * entry becomes the LB address: limits then collapse to one shared bucket (fail-closed, never
 * spoofable) and this must be changed to the second-to-last entry.
 */
export function forwardedFor(req: IncomingMessage): string[] {
  const header = req.headers['x-forwarded-for'];
  const value = Array.isArray(header) ? header.join(',') : header;
  return (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * `trustedProxyHops` = proxies that append to X-Forwarded-For before us: the client IP is the
 * entry that many positions from the right. Entries further left are client-controlled.
 */
export function clientIp(req: IncomingMessage, trustedProxyHops: number): string {
  const socketIp = req.socket.remoteAddress ?? 'unknown';
  if (trustedProxyHops <= 0) return socketIp;
  const candidate = forwardedFor(req).at(-trustedProxyHops);
  return candidate && /^[0-9A-Fa-f.:]{2,45}$/.test(candidate) ? candidate : socketIp;
}

export type RateLimiter = { hit: (key: string) => boolean; prune: () => void };

/** Fixed-window counter. hit() returns true when the key is over the limit. */
export function createRateLimiter(windowMs: number, max: number, now: () => number = Date.now): RateLimiter {
  const counts = new Map<string, { start: number; count: number }>();
  return {
    hit(key) {
      const at = now();
      const entry = counts.get(key);
      if (!entry || at - entry.start > windowMs) {
        counts.set(key, { start: at, count: 1 });
        return false;
      }
      entry.count += 1;
      return entry.count > max;
    },
    prune() {
      const at = now();
      for (const [key, entry] of counts) if (at - entry.start > windowMs) counts.delete(key);
    },
  };
}

/** decodeURIComponent that returns null instead of throwing on malformed escapes like "%E0%A4%A". */
export function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/** Pathname with a fixed base: the Host header is client-controlled and new URL() throws on garbage. */
export function parsePathname(rawUrl: string | undefined): string | null {
  try {
    return new URL(rawUrl ?? '/', 'http://localhost').pathname;
  } catch {
    return null;
  }
}
