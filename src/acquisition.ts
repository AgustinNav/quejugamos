// Acquisition signals sent on room creation. They only feed the `room_created` log line (the durable
// record: memory is wiped on every Render spin-down); they are never stored in the room or echoed.
import { HttpError } from './http.ts';

// Closed vocabulary: a client string never becomes a log value or a key as-is.
export const REF_SOURCES: ReadonlySet<string> = new Set(['tt', 'ig', 'yt', 'x', 'rd', 'dc', 'twitch', 'wa', 'gh', 'qr', 'yo']);

function invalidBody(message: string): HttpError {
  return new HttpError(400, 'invalid_body', message);
}

/** Missing/null → `direct`; known source → itself; any other string → `other`; non-string → 400. */
export function normalizeRef(value: unknown): string {
  if (value === undefined || value === null) return 'direct';
  if (typeof value !== 'string') throw invalidBody('ref must be a string');
  return REF_SOURCES.has(value) ? value : 'other';
}

/** Missing → false; anything but a boolean → 400. */
export function parseViaGuest(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw invalidBody('viaGuest must be a boolean');
  return value;
}
