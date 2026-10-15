// HTTP validators for static files. Without them browsers cache heuristically and keep running
// old JS/CSS after a deploy, so code and markup are revalidated on every load (cheap 304s).
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const IMAGE_EXT = new Set(['.png', '.ico', '.svg', '.jpg', '.jpeg', '.webp']);
// Images are never rewritten in place under the same name in practice, and a stale OG image is harmless.
const IMAGE_CACHE = 'public, max-age=86400';
const REVALIDATE = 'no-cache';

export function strongEtag(content: string | Buffer): string {
  return `"${createHash('sha256').update(content).digest('base64url').slice(0, 27)}"`;
}

export function cacheControlFor(filePath: string): string {
  return IMAGE_EXT.has(path.extname(filePath).toLowerCase()) ? IMAGE_CACHE : REVALIDATE;
}

/** If-None-Match uses the weak comparison (RFC 9110 §13.1.2): a W/ prefix on the client's tag still matches. */
export function etagMatches(header: string | string[] | undefined, etag: string): boolean {
  if (header === undefined) return false;
  const value = Array.isArray(header) ? header.join(',') : header;
  return value.split(',').some((raw) => {
    const tag = raw.trim();
    return tag === '*' || tag.replace(/^W\//, '') === etag;
  });
}

export type CachedFile = { content: Buffer; etag: string };

/**
 * Reads files through an in-memory cache keyed by mtime and size, so the hash is computed once per version.
 * Bounded by the files that exist under public/: a miss throws before anything is stored.
 */
export function createFileCache(): (filePath: string) => Promise<CachedFile> {
  const cache = new Map<string, CachedFile & { mtimeMs: number; size: number }>();
  return async (filePath) => {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) throw Object.assign(new Error('Not a file'), { code: 'EISDIR' });
    const hit = cache.get(filePath);
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit;
    const content = await fs.readFile(filePath);
    const entry = { content, etag: strongEtag(content), mtimeMs: stat.mtimeMs, size: stat.size };
    cache.set(filePath, entry);
    return entry;
  };
}
