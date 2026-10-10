// Room codes: 6 chars from an alphabet without ambiguous glyphs (see docs/API.md).
const CODE_PATTERN = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/;

export function normalizeCode(raw) {
  const code = String(raw ?? '').trim().toUpperCase();
  return CODE_PATTERN.test(code) ? code : null;
}

// Accepts a bare code or a pasted invite link (".../r/K7Q2MX").
export function extractCode(input) {
  const text = String(input ?? '').trim();
  const fromUrl = text.match(/\/r\/([A-Za-z0-9]+)\/?$/);
  return normalizeCode(fromUrl ? fromUrl[1] : text);
}

export function roomUrl(code) {
  return `${location.origin}/r/${code}`;
}
