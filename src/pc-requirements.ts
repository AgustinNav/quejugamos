// Steam returns PC requirements as HTML fragments. Clients only ever get plain text lines.
export type PcRequirements = { minimum: string[]; recommended: string[] };

const MAX_LINES = 12;
const MAX_LINE_LENGTH = 200;
const MAX_INPUT_LENGTH = 20_000;
const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-' };
// "Mínimos:", "Minimum:", "Recomendado:", "Recommended:" are section headings, not requirements.
const HEADING = /^(m[ií]nim(o|os|um)|recomendad(o|os)|recommended)\s*:?$/i;

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1].toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ' ';
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** HTML fragment -> clean text lines. Angle brackets that survive decoding are dropped: the output is text only. */
export function htmlToLines(html: unknown): string[] {
  if (typeof html !== 'string') return [];
  const withBreaks = html.slice(0, MAX_INPUT_LENGTH).replace(/<\s*\/?\s*(br|li|p|div|ul)\b[^>]*>/gi, '\n');
  const plain = decodeEntities(withBreaks.replace(/<[^>]*>?/g, '')).replace(/[<>]/g, '');
  return plain
    .split('\n')
    .map((line) => line.replace(/[\s ]+/g, ' ').trim().slice(0, MAX_LINE_LENGTH))
    .filter((line) => line && !HEADING.test(line))
    .slice(0, MAX_LINES);
}

/** `pc_requirements` is `[]` (an array) when Steam has none, so anything non-object is "no data". */
export function parsePcRequirements(raw: unknown): PcRequirements | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { minimum, recommended } = raw as Record<string, unknown>;
  const result = { minimum: htmlToLines(minimum), recommended: htmlToLines(recommended) };
  return result.minimum.length || result.recommended.length ? result : null;
}
