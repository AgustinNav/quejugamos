// Pure sort/filter over ranking rows (no DOM, covered by test/ranking-sort.test.ts).
// A row is { match, price, discount, maxPlayers, name, ... } where `price` is USD (null = unknown),
// `discount` a 0-100 percentage and rows arrive in the default (server-frozen) ranking order.
// That arrival order is the tie-break of every sort, so results never shuffle between renders.

export const SORTS = [
  { key: 'votes', label: 'Más votados' },
  { key: 'cheap', label: 'Más baratos' },
  { key: 'discount', label: 'Mayor descuento' },
  { key: 'players', label: 'Más jugadores' },
  { key: 'name', label: 'A–Z' },
];

export const FILTERS = [
  { key: 'match', label: 'Solo matches 💘' },
  { key: 'sale', label: 'Solo en oferta 🔥' },
  { key: 'free', label: 'Gratis' },
];

export const DEFAULT_PREFS = Object.freeze({ sort: 'votes', match: false, sale: false, free: false });

/** Whatever was stored (possibly garbage or from an older version) becomes a valid prefs object. */
export function normalizePrefs(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const sort = SORTS.some((s) => s.key === src.sort) ? src.sort : DEFAULT_PREFS.sort;
  return { sort, match: src.match === true, sale: src.sale === true, free: src.free === true };
}

export const hasActiveFilters = (prefs) => FILTERS.some((f) => prefs[f.key]);

const UNKNOWN_LAST = Number.POSITIVE_INFINITY;

// Infinity - Infinity is NaN (two unknown prices): treat it as "equal".
const safe = (n) => (Number.isNaN(n) ? 0 : n);

const COMPARATORS = {
  votes: () => 0, // rows already arrive in vote order
  cheap: (a, b) => safe((a.price ?? UNKNOWN_LAST) - (b.price ?? UNKNOWN_LAST)),
  discount: (a, b) => (b.discount || 0) - (a.discount || 0),
  players: (a, b) => (b.maxPlayers || 0) - (a.maxPlayers || 0),
  name: (a, b) => String(a.name).localeCompare(String(b.name), 'es', { sensitivity: 'base' }),
};

const PREDICATES = {
  match: (r) => r.match === true,
  sale: (r) => (r.discount || 0) > 0,
  free: (r) => r.price === 0,
};

/** Filters combine with AND. Returns a new array. */
export function filterRows(rows, prefs) {
  const active = FILTERS.filter((f) => prefs[f.key]).map((f) => PREDICATES[f.key]);
  return rows.filter((row) => active.every((test) => test(row)));
}

/** Stable sort: equal keys keep the incoming order. Returns a new array. */
export function sortRows(rows, sortKey) {
  const compare = COMPARATORS[sortKey] || COMPARATORS.votes;
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => compare(a.row, b.row) || a.index - b.index)
    .map(({ row }) => row);
}

export const applyView = (rows, prefs) => sortRows(filterRows(rows, prefs), prefs.sort);

/** Price/discount sorts and filters need Steam details for every row, not just the visible top. */
export const needsAllDetails = (prefs) => prefs.sort === 'cheap' || prefs.sort === 'discount' || prefs.sale || prefs.free;
