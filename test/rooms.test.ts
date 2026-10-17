import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CODE_ALPHABET, RoomError, RoomStore } from '../src/rooms.ts';
import type { Filters, RoomLimits } from '../src/rooms.ts';

const FILTERS: Filters = { platforms: ['PC'], maxPrice: null, fitsGroup: true, playerCount: null };
const DECK = ['a', 'b', 'c'];
const fixedDeck = () => [...DECK];

function makeStore(limits: Partial<RoomLimits> = {}) {
  const clock = { t: 1_000_000 };
  let counter = 0;
  let seed = 42;
  const expired: string[] = [];
  const reasons: string[] = [];
  const store = new RoomStore({
    now: () => clock.t,
    // Deterministic LCG: reproducible codes without cycling through a tiny period.
    randomInt: (max) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return Math.floor((seed / 2147483648) * max);
    },
    uuid: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`,
    onExpire: (code, reason) => { expired.push(code); reasons.push(reason); },
  }, limits);
  return { store, clock, expired, reasons };
}

function expectError(fn: () => unknown, status: number, code: string) {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof RoomError, `expected RoomError, got ${err}`);
    assert.equal(err.status, status);
    assert.equal(err.code, code);
    return true;
  });
}

/** Room in voting with host + 2 guests. */
function votingRoom() {
  const ctx = makeStore();
  const host = ctx.store.create('Host', '1.1.1.1');
  const ana = ctx.store.join(host.code, 'Ana');
  const bob = ctx.store.join(host.code, 'Bob');
  ctx.store.start(host.code, host.hostToken, FILTERS, fixedDeck);
  return { ...ctx, host, ana, bob, code: host.code };
}

describe('name validation (invisible / impersonating names)', () => {
  const INVALID: Record<string, string> = {
    'zero-width space only': '​',
    'zero-width chars around a name': 'A​na',
    'Hangul filler U+3164': 'ㅤ',
    'Hangul choseong filler U+115F': 'Anaᅟ',
    'Hangul jungseong filler U+1160': 'ᅠAna',
    'halfwidth Hangul filler U+FFA0': 'ﾠ',
    'right-to-left mark': 'Ana‏',
    'embedded newline': 'An\na',
    'line separator U+2028': 'An a',
    'paragraph separator U+2029': 'An a',
    '15 combining marks': 'a' + '́'.repeat(15),
    '3 stacked combining marks': 'á̂̃',
    'only punctuation': '...',
    'only combining marks': '́̂',
    'soft hyphen': 'An­a',
    'ZWJ outside an emoji sequence': 'A‍na',
  };
  for (const [label, bad] of Object.entries(INVALID)) {
    test(`rejects ${label}`, () => expectError(() => makeStore().store.create(bad, '1.1.1.1'), 400, 'invalid_name'));
  }

  for (const good of ['Agus', 'Ñoño', 'José', 'Juli 🎮', '42', 'éé', '👨‍👩‍👧', '1️⃣ Uno', 'Zoë']) {
    test(`accepts ${JSON.stringify(good)}`, () => {
      const { store } = makeStore();
      const { code } = store.create(good, '1.1.1.1');
      assert.equal(store.snapshot(code).players[0].name, good.normalize('NFC'));
    });
  }

  test('uniqueness folds case, compatibility forms and invisible code points', () => {
    const { store } = makeStore();
    const { code } = store.create('Agus', '1.1.1.1');
    expectError(() => store.join(code, 'ＡＧＵＳ'), 409, 'name_taken'); // fullwidth
    expectError(() => store.join(code, 'agus️'), 409, 'name_taken'); // variation selector
    store.join(code, 'José');
    expectError(() => store.join(code, 'José'), 409, 'name_taken'); // decomposed accent
    store.join(code, 'Ana 🎮');
    expectError(() => store.join(code, 'ana 🎮️'), 409, 'name_taken');
  });
});

describe('create', () => {
  test('returns code, tokens and host as first player', () => {
    const { store } = makeStore();
    const created = store.create('  Agus ', '1.1.1.1');
    assert.match(created.code, new RegExp(`^[${CODE_ALPHABET}]{6}$`));
    assert.equal(created.hostToken, created.playerToken);
    const snap = store.snapshot(created.code);
    assert.deepEqual(snap.players, [{ id: created.playerId, name: 'Agus', isHost: true }]);
    assert.equal(snap.phase, 'lobby');
    assert.equal(snap.filters, null);
    assert.equal(snap.lastResult, null);
  });

  test('lookups are case-insensitive', () => {
    const { store } = makeStore();
    const { code } = store.create('Agus', '1.1.1.1');
    assert.equal(store.snapshot(code.toLowerCase()).code, code);
  });

  test('snapshots never contain tokens', () => {
    const { store } = makeStore();
    const created = store.create('Agus', '1.1.1.1');
    const json = JSON.stringify(store.snapshot(created.code));
    assert.ok(!json.includes(created.hostToken));
  });

  for (const bad of ['', '   ', 'x'.repeat(17), 'a\u0000b', 'bad\nname', 'evil‮name', 42, null, undefined, ['a']]) {
    test(`rejects invalid host name ${JSON.stringify(bad)}`, () => {
      expectError(() => makeStore().store.create(bad, '1.1.1.1'), 400, 'invalid_name');
    });
  }

  test('accepts 16 characters counting emoji as one', () => {
    const { store } = makeStore();
    assert.ok(store.create('🎮'.repeat(16), '1.1.1.1').code);
  });
});

describe('join', () => {
  let ctx: ReturnType<typeof makeStore>;
  let code: string;
  beforeEach(() => {
    ctx = makeStore();
    code = ctx.store.create('Host', '1.1.1.1').code;
  });

  test('adds a non-host player and bumps version', () => {
    const before = ctx.store.snapshot(code).version;
    const joined = ctx.store.join(code, 'Ana');
    assert.match(joined.playerId, /^p_/);
    assert.equal(joined.snapshot.players[1].isHost, false);
    assert.equal(joined.snapshot.version, before + 1);
  });

  test('rejects invalid name', () => expectError(() => ctx.store.join(code, ''), 400, 'invalid_name'));
  test('rejects unknown room', () => expectError(() => ctx.store.join('ZZZZZZ', 'Ana'), 404, 'room_not_found'));

  test('rejects duplicate name case-insensitively', () => {
    ctx.store.join(code, 'Ana');
    expectError(() => ctx.store.join(code, ' aNA '), 409, 'name_taken');
    expectError(() => ctx.store.join(code, 'host'), 409, 'name_taken');
  });

  test('rejects when the room is full (12 players)', () => {
    for (let i = 1; i < 12; i += 1) ctx.store.join(code, `P${i}`);
    expectError(() => ctx.store.join(code, 'Late'), 409, 'room_full');
  });

  test('rejects when the room is finished', () => {
    const host = ctx.store.create('H2', '2.2.2.2');
    ctx.store.start(host.code, host.hostToken, FILTERS, () => ['only']);
    ctx.store.vote(host.code, host.playerToken, 'only', 'like');
    assert.equal(ctx.store.snapshot(host.code).phase, 'finished');
    expectError(() => ctx.store.join(host.code, 'Ana'), 409, 'room_finished');
  });

  test('allows joining mid-voting from the current card', () => {
    const r = votingRoom();
    const late = r.store.join(r.code, 'Late');
    assert.equal(late.snapshot.phase, 'voting');
    assert.equal(late.snapshot.index, 0);
  });
});

describe('start', () => {
  test('sets filters, deck and voting phase', () => {
    const { store } = makeStore();
    const host = store.create('Host', '1.1.1.1');
    let seenCount = -1;
    const snap = store.start(host.code, host.hostToken, FILTERS, (_f, n) => { seenCount = n; return fixedDeck(); });
    assert.equal(seenCount, 1);
    assert.equal(snap.phase, 'voting');
    assert.deepEqual(snap.deck, DECK);
    assert.deepEqual(snap.filters, FILTERS);
    assert.equal(snap.index, 0);
  });

  test('rejects a non-host player', () => {
    const { store } = makeStore();
    const host = store.create('Host', '1.1.1.1');
    const ana = store.join(host.code, 'Ana');
    expectError(() => store.start(host.code, ana.playerToken, FILTERS, fixedDeck), 403, 'not_host');
  });

  test('rejects missing or foreign token', () => {
    const { store } = makeStore();
    const host = store.create('Host', '1.1.1.1');
    const other = store.create('Other', '1.1.1.1');
    expectError(() => store.start(host.code, null, FILTERS, fixedDeck), 401, 'unauthorized');
    expectError(() => store.start(host.code, other.hostToken, FILTERS, fixedDeck), 401, 'unauthorized');
  });

  test('rejects an empty deck without changing state', () => {
    const { store } = makeStore();
    const host = store.create('Host', '1.1.1.1');
    const version = store.snapshot(host.code).version;
    expectError(() => store.start(host.code, host.hostToken, FILTERS, () => []), 422, 'empty_deck');
    assert.equal(store.snapshot(host.code).phase, 'lobby');
    assert.equal(store.snapshot(host.code).version, version);
  });

  test('rejects starting twice', () => {
    const r = votingRoom();
    expectError(() => r.store.start(r.code, r.host.hostToken, FILTERS, fixedDeck), 409, 'already_started');
  });
});

describe('vote', () => {
  test('rejects bad token', () => {
    const r = votingRoom();
    expectError(() => r.store.vote(r.code, 'nope-token', 'a', 'like'), 401, 'unauthorized');
    expectError(() => r.store.vote(r.code, null, 'a', 'like'), 401, 'unauthorized');
  });

  test('rejects a token from another room', () => {
    const r = votingRoom();
    const other = r.store.create('Other', '9.9.9.9');
    expectError(() => r.store.vote(r.code, other.playerToken, 'a', 'like'), 401, 'unauthorized');
  });

  test('rejects invalid vote payloads', () => {
    const r = votingRoom();
    expectError(() => r.store.vote(r.code, r.ana.playerToken, 'a', 'maybe'), 400, 'invalid_vote');
    expectError(() => r.store.vote(r.code, r.ana.playerToken, 42, 'like'), 400, 'invalid_vote');
    expectError(() => r.store.vote(r.code, r.ana.playerToken, 'a', undefined), 400, 'invalid_vote');
  });

  test('rejects a game that is not the current card', () => {
    const r = votingRoom();
    expectError(() => r.store.vote(r.code, r.ana.playerToken, 'b', 'like'), 409, 'not_current_game');
  });

  test('rejects voting in lobby', () => {
    const { store } = makeStore();
    const host = store.create('Host', '1.1.1.1');
    expectError(() => store.vote(host.code, host.playerToken, 'a', 'like'), 409, 'not_voting');
  });

  test('records, changes and clears a vote', () => {
    const r = votingRoom();
    let snap = r.store.vote(r.code, r.ana.playerToken, 'a', 'like');
    assert.deepEqual(snap.currentVoters, [r.ana.playerId]);
    assert.equal(r.store.currentVote(r.code, r.ana.playerToken).vote, 'like');
    snap = r.store.vote(r.code, r.ana.playerToken, 'a', 'nope');
    assert.equal(r.store.currentVote(r.code, r.ana.playerToken).vote, 'nope');
    snap = r.store.vote(r.code, r.ana.playerToken, 'a', null);
    assert.deepEqual(snap.currentVoters, []);
    assert.deepEqual(r.store.currentVote(r.code, r.ana.playerToken), { playerId: r.ana.playerId, gameId: 'a', vote: null, superlikeAvailable: true });
    assert.equal(snap.index, 0);
  });

  test('snapshots hide who voted what on the open card until it closes', () => {
    const r = votingRoom();
    r.store.vote(r.code, r.ana.playerToken, 'a', 'nope');
    const open = r.store.snapshot(r.code);
    assert.deepEqual(open.votes, {});
    assert.deepEqual(open.currentVoters, [r.ana.playerId]);
    assert.ok(!JSON.stringify(open).includes('nope'), 'open-card vote leaked');
    r.store.vote(r.code, r.host.playerToken, 'a', 'like');
    const closed = r.store.vote(r.code, r.bob.playerToken, 'a', 'like');
    assert.deepEqual(closed.votes.a, { [r.ana.playerId]: 'nope', [r.host.playerId]: 'like', [r.bob.playerId]: 'like' });
    assert.deepEqual(closed.currentVoters, []);
  });

  test('currentVote rejects foreign tokens and is null outside voting', () => {
    const r = votingRoom();
    expectError(() => r.store.currentVote(r.code, 'nope'), 401, 'unauthorized');
    const { store } = makeStore();
    const host = store.create('Host', '1.1.1.1');
    assert.deepEqual(store.currentVote(host.code, host.playerToken), { playerId: host.playerId, gameId: null, vote: null, superlikeAvailable: true });
  });

  test('version increments on change and stays on a no-op vote', () => {
    const r = votingRoom();
    const v0 = r.store.snapshot(r.code).version;
    const v1 = r.store.vote(r.code, r.ana.playerToken, 'a', 'like').version;
    const v2 = r.store.vote(r.code, r.ana.playerToken, 'a', 'like').version;
    assert.equal(v1, v0 + 1);
    assert.equal(v2, v1);
  });

  test('auto-advances with match when everyone likes', () => {
    const r = votingRoom();
    r.store.vote(r.code, r.host.playerToken, 'a', 'like');
    r.store.vote(r.code, r.ana.playerToken, 'a', 'like');
    const snap = r.store.vote(r.code, r.bob.playerToken, 'a', 'like');
    assert.equal(snap.index, 1);
    assert.deepEqual(snap.lastResult, { gameId: 'a', likes: 3, superlikes: 0, superlikedBy: [], nopes: 0, played: 0, playedOut: false, match: true });
  });

  test('results keep a past match frozen when a player joins later', () => {
    const r = votingRoom();
    for (const p of [r.host, r.ana, r.bob]) r.store.vote(r.code, p.playerToken, 'a', 'like');
    r.store.join(r.code, 'Late');
    const snap = r.store.snapshot(r.code);
    assert.deepEqual(snap.results, { a: { gameId: 'a', likes: 3, superlikes: 0, superlikedBy: [], nopes: 0, played: 0, playedOut: false, match: true } });
  });

  test('undo removes the reopened card from results', () => {
    const r = votingRoom();
    for (const p of [r.host, r.ana, r.bob]) r.store.vote(r.code, p.playerToken, 'a', 'like');
    const snap = r.store.undo(r.code, r.host.hostToken);
    assert.deepEqual(snap.results, {});
  });

  test('auto-advances without match on a split vote', () => {
    const r = votingRoom();
    r.store.vote(r.code, r.host.playerToken, 'a', 'like');
    r.store.vote(r.code, r.ana.playerToken, 'a', 'nope');
    const snap = r.store.vote(r.code, r.bob.playerToken, 'a', 'like');
    assert.deepEqual(snap.lastResult, { gameId: 'a', likes: 2, superlikes: 0, superlikedBy: [], nopes: 1, played: 0, playedOut: false, match: false });
  });

  test('a late joiner is required for auto-advance', () => {
    const r = votingRoom();
    r.store.vote(r.code, r.host.playerToken, 'a', 'like');
    r.store.vote(r.code, r.ana.playerToken, 'a', 'like');
    const late = r.store.join(r.code, 'Late');
    const snap = r.store.vote(r.code, r.bob.playerToken, 'a', 'like');
    assert.equal(snap.index, 0);
    assert.equal(r.store.vote(r.code, late.playerToken, 'a', 'like').index, 1);
  });

  test('finishes after the last card', () => {
    const r = votingRoom();
    for (const gameId of DECK) {
      for (const p of [r.host, r.ana, r.bob]) r.store.vote(r.code, p.playerToken, gameId, 'nope');
    }
    const snap = r.store.snapshot(r.code);
    assert.equal(snap.phase, 'finished');
    assert.equal(snap.index, 3);
    expectError(() => r.store.vote(r.code, r.ana.playerToken, 'c', 'like'), 409, 'not_voting');
  });
});

describe('next', () => {
  test('closes the card with missing votes (no match)', () => {
    const r = votingRoom();
    r.store.vote(r.code, r.ana.playerToken, 'a', 'like');
    const snap = r.store.next(r.code, r.host.hostToken);
    assert.equal(snap.index, 1);
    assert.deepEqual(snap.lastResult, { gameId: 'a', likes: 1, superlikes: 0, superlikedBy: [], nopes: 0, played: 0, playedOut: false, match: false });
  });

  test('requires the host', () => {
    const r = votingRoom();
    expectError(() => r.store.next(r.code, r.ana.playerToken), 403, 'not_host');
  });

  test('rejects in lobby and finished', () => {
    const { store } = makeStore();
    const host = store.create('Host', '1.1.1.1');
    expectError(() => store.next(host.code, host.hostToken), 409, 'not_voting');
    store.start(host.code, host.hostToken, FILTERS, () => ['x']);
    store.next(host.code, host.hostToken);
    expectError(() => store.next(host.code, host.hostToken), 409, 'not_voting');
  });
});

describe('undo', () => {
  test('reopens the previous card and clears its votes', () => {
    const r = votingRoom();
    r.store.vote(r.code, r.ana.playerToken, 'a', 'like');
    r.store.next(r.code, r.host.hostToken);
    const snap = r.store.undo(r.code, r.host.hostToken);
    assert.equal(snap.index, 0);
    assert.equal(snap.votes.a, undefined);
    assert.equal(snap.lastResult, null);
  });

  test('reopens the last card from finished', () => {
    const { store } = makeStore();
    const host = store.create('Host', '1.1.1.1');
    store.start(host.code, host.hostToken, FILTERS, () => ['x']);
    store.next(host.code, host.hostToken);
    const snap = store.undo(host.code, host.hostToken);
    assert.equal(snap.phase, 'voting');
    assert.equal(snap.index, 0);
  });

  test('rejects with nothing to undo', () => {
    const r = votingRoom();
    expectError(() => r.store.undo(r.code, r.host.hostToken), 409, 'nothing_to_undo');
  });

  test('requires the host', () => {
    const r = votingRoom();
    r.store.next(r.code, r.host.hostToken);
    expectError(() => r.store.undo(r.code, r.bob.playerToken), 403, 'not_host');
  });
});

describe('finish (end voting early)', () => {
  test('mid-deck: keeps closed results, discards the open card and its votes', () => {
    const r = votingRoom();
    for (const p of [r.host, r.ana, r.bob]) r.store.vote(r.code, p.playerToken, 'a', 'like');
    r.store.vote(r.code, r.ana.playerToken, 'b', 'nope');
    r.store.next(r.code, r.host.hostToken); // b closes with 1 nope
    r.store.vote(r.code, r.ana.playerToken, 'c', 'like'); // open card, must be dropped
    const before = r.store.snapshot(r.code);
    const snap = r.store.finish(r.code, r.host.hostToken);
    assert.equal(snap.phase, 'finished');
    assert.equal(snap.index, 2);
    assert.equal(snap.version, before.version + 1);
    assert.equal(snap.lastResult, null);
    assert.deepEqual(Object.keys(snap.results), ['a', 'b']);
    assert.deepEqual(snap.results.a, { gameId: 'a', likes: 3, superlikes: 0, superlikedBy: [], nopes: 0, played: 0, playedOut: false, match: true });
    assert.equal(snap.results.c, undefined);
    // Outside voting the open card's votes would show up in `votes`: they must be gone, not leaked.
    assert.equal(snap.votes.c, undefined);
    assert.deepEqual(snap.currentVoters, []);
  });

  test('on the first card: finishes with no results', () => {
    const r = votingRoom();
    const snap = r.store.finish(r.code, r.host.hostToken);
    assert.equal(snap.phase, 'finished');
    assert.equal(snap.index, 0);
    assert.deepEqual(snap.results, {});
  });

  test('rejects in lobby and when already finished (409 not_voting)', () => {
    const { store } = makeStore();
    const host = store.create('Host', '1.1.1.1');
    expectError(() => store.finish(host.code, host.hostToken), 409, 'not_voting');
    store.start(host.code, host.hostToken, FILTERS, fixedDeck);
    store.finish(host.code, host.hostToken);
    expectError(() => store.finish(host.code, host.hostToken), 409, 'not_voting');
  });

  test('rejects after the deck ran out (normal finish)', () => {
    const { store } = makeStore();
    const host = store.create('Host', '1.1.1.1');
    store.start(host.code, host.hostToken, FILTERS, () => ['x']);
    store.next(host.code, host.hostToken);
    expectError(() => store.finish(host.code, host.hostToken), 409, 'not_voting');
  });

  test('requires the host (403) and a valid token (401), without changing state', () => {
    const r = votingRoom();
    const version = r.store.snapshot(r.code).version;
    expectError(() => r.store.finish(r.code, r.ana.playerToken), 403, 'not_host');
    expectError(() => r.store.finish(r.code, null), 401, 'unauthorized');
    expectError(() => r.store.finish(r.code, 'nope'), 401, 'unauthorized');
    assert.equal(r.store.snapshot(r.code).phase, 'voting');
    assert.equal(r.store.snapshot(r.code).version, version);
  });

  test('votes are rejected once finished; joins are refused', () => {
    const r = votingRoom();
    r.store.finish(r.code, r.host.hostToken);
    expectError(() => r.store.vote(r.code, r.ana.playerToken, 'a', 'like'), 409, 'not_voting');
    expectError(() => r.store.vote(r.code, r.ana.playerToken, 'a', 'played'), 409, 'not_voting');
    expectError(() => r.store.join(r.code, 'Late'), 409, 'room_finished');
  });

  test('undo reopens the card that was open, with no votes, and keeps closed results', () => {
    const r = votingRoom();
    r.store.vote(r.code, r.ana.playerToken, 'a', 'like');
    r.store.next(r.code, r.host.hostToken);
    r.store.vote(r.code, r.ana.playerToken, 'b', 'like');
    r.store.finish(r.code, r.host.hostToken);
    const snap = r.store.undo(r.code, r.host.hostToken);
    assert.equal(snap.phase, 'voting');
    assert.equal(snap.index, 1);
    assert.equal(snap.lastResult, null);
    assert.deepEqual(Object.keys(snap.results), ['a']);
    assert.deepEqual(snap.currentVoters, []);
    assert.equal(r.store.currentVote(r.code, r.ana.playerToken).vote, null);
    // Voting continues normally from there, and a second undo reopens the previous closed card.
    for (const p of [r.host, r.ana, r.bob]) r.store.vote(r.code, p.playerToken, 'b', 'nope');
    assert.equal(r.store.snapshot(r.code).index, 2);
    assert.equal(r.store.undo(r.code, r.host.hostToken).index, 1);
  });

  test('undo right after finishing on the first card reopens it', () => {
    const r = votingRoom();
    r.store.finish(r.code, r.host.hostToken);
    const snap = r.store.undo(r.code, r.host.hostToken);
    assert.equal(snap.phase, 'voting');
    assert.equal(snap.index, 0);
  });

  test('undo after an early finish requires the host', () => {
    const r = votingRoom();
    r.store.finish(r.code, r.host.hostToken);
    expectError(() => r.store.undo(r.code, r.bob.playerToken), 403, 'not_host');
    assert.equal(r.store.snapshot(r.code).phase, 'finished');
  });
});

describe('kick', () => {
  test('removes the player, drops their current vote and bumps the version', () => {
    const r = votingRoom();
    r.store.vote(r.code, r.bob.playerToken, 'a', 'like');
    const before = r.store.snapshot(r.code);
    const snap = r.store.kick(r.code, r.host.hostToken, r.bob.playerId);
    assert.deepEqual(snap.players.map((p) => p.id), [r.host.playerId, r.ana.playerId]);
    assert.deepEqual(snap.currentVoters, []);
    assert.equal(snap.index, 0);
    assert.equal(snap.version, before.version + 1);
  });

  test('works in the lobby too', () => {
    const { store } = makeStore();
    const host = store.create('Host', '1.1.1.1');
    const ana = store.join(host.code, 'Ana');
    const snap = store.kick(host.code, host.hostToken, ana.playerId);
    assert.equal(snap.players.length, 1);
    assert.equal(snap.phase, 'lobby');
    assert.ok(store.join(host.code, 'Ana').playerId, 'the name is free again');
  });

  test('kicking the only missing voter closes the card with a match', () => {
    const r = votingRoom();
    r.store.vote(r.code, r.host.playerToken, 'a', 'like');
    r.store.vote(r.code, r.ana.playerToken, 'a', 'like');
    const snap = r.store.kick(r.code, r.host.hostToken, r.bob.playerId);
    assert.equal(snap.index, 1);
    assert.deepEqual(snap.lastResult, { gameId: 'a', likes: 2, superlikes: 0, superlikedBy: [], nopes: 0, played: 0, playedOut: false, match: true });
    assert.deepEqual(snap.results.a, { gameId: 'a', likes: 2, superlikes: 0, superlikedBy: [], nopes: 0, played: 0, playedOut: false, match: true });
  });

  test('a kicked voter does not count toward the closing result', () => {
    const r = votingRoom();
    r.store.vote(r.code, r.host.playerToken, 'a', 'like');
    r.store.vote(r.code, r.bob.playerToken, 'a', 'nope');
    r.store.kick(r.code, r.host.hostToken, r.bob.playerId);
    const snap = r.store.vote(r.code, r.ana.playerToken, 'a', 'like');
    assert.deepEqual(snap.lastResult, { gameId: 'a', likes: 2, superlikes: 0, superlikedBy: [], nopes: 0, played: 0, playedOut: false, match: true });
  });

  test('does not close the card while remaining players are missing votes', () => {
    const r = votingRoom();
    r.store.vote(r.code, r.host.playerToken, 'a', 'like');
    assert.equal(r.store.kick(r.code, r.host.hostToken, r.bob.playerId).index, 0);
  });

  test('past results stay frozen', () => {
    const r = votingRoom();
    for (const p of [r.host, r.ana, r.bob]) r.store.vote(r.code, p.playerToken, 'a', 'like');
    const before = r.store.snapshot(r.code);
    const snap = r.store.kick(r.code, r.host.hostToken, r.bob.playerId);
    assert.deepEqual(snap.results, before.results);
    assert.deepEqual(snap.votes.a, before.votes.a);
  });

  test("the kicked player's token is rejected afterwards", () => {
    const r = votingRoom();
    r.store.kick(r.code, r.host.hostToken, r.bob.playerId);
    expectError(() => r.store.vote(r.code, r.bob.playerToken, 'a', 'like'), 401, 'unauthorized');
  });

  test('cannot kick the host', () => {
    const r = votingRoom();
    expectError(() => r.store.kick(r.code, r.host.hostToken, r.host.playerId), 409, 'cannot_kick_host');
  });

  test('requires the host', () => {
    const r = votingRoom();
    expectError(() => r.store.kick(r.code, r.ana.playerToken, r.bob.playerId), 403, 'not_host');
    expectError(() => r.store.kick(r.code, null, r.bob.playerId), 401, 'unauthorized');
  });

  test('unknown player is 404 and malformed ids are 400', () => {
    const r = votingRoom();
    const version = r.store.snapshot(r.code).version;
    expectError(() => r.store.kick(r.code, r.host.hostToken, 'p_nobody'), 404, 'player_not_found');
    for (const bad of [undefined, null, 42, '', 'x'.repeat(65), ['p_1']]) {
      expectError(() => r.store.kick(r.code, r.host.hostToken, bad), 400, 'invalid_player');
    }
    assert.equal(r.store.snapshot(r.code).version, version, 'failed kicks do not bump the version');
  });
});

describe('limits and expiry', () => {
  test('rooms expire after 2 h without activity', () => {
    const { store, clock, expired } = makeStore();
    const { code } = store.create('Host', '1.1.1.1');
    store.join(code, 'Ana');
    clock.t += 2 * 60 * 60 * 1000;
    assert.deepEqual(store.expire(), []);
    clock.t += 1;
    assert.deepEqual(store.expire(), [code]);
    assert.deepEqual(expired, [code]);
    expectError(() => store.snapshot(code), 404, 'room_not_found');
  });

  test('a lobby with only the host expires after 20 min idle', () => {
    const { store, clock, expired } = makeStore();
    const lone = store.create('Host', '1.1.1.1');
    const joined = store.create('Host', '1.1.1.2');
    store.join(joined.code, 'Ana');
    clock.t += 20 * 60 * 1000;
    assert.deepEqual(store.expire(), []);
    clock.t += 1;
    assert.deepEqual(store.expire(), [lone.code]);
    assert.deepEqual(expired, [lone.code]);
    assert.equal(store.snapshot(joined.code).phase, 'lobby');
  });

  test('a lone host that already started voting keeps the 2 h TTL', () => {
    const { store, clock } = makeStore();
    const { code, hostToken } = store.create('Host', '1.1.1.1');
    store.start(code, hostToken, FILTERS, fixedDeck);
    clock.t += 21 * 60 * 1000;
    assert.deepEqual(store.expire(), []);
  });

  test('at capacity, the longest-idle lone-host lobby is evicted first', () => {
    const { store, clock, expired } = makeStore({ maxRooms: 3 });
    const busy = store.create('Host', '10.0.0.1');
    store.join(busy.code, 'Ana');
    const older = store.create('Host', '10.0.0.2');
    clock.t += 60_000;
    const newer = store.create('Host', '10.0.0.3');
    clock.t += 5 * 60 * 1000;
    const created = store.create('Host', '10.0.0.4');
    assert.deepEqual(expired, [older.code]);
    for (const code of [busy.code, newer.code, created.code]) assert.ok(store.snapshot(code));
  });

  test('at capacity, a lobby created moments ago is not evicted', () => {
    const { store, clock } = makeStore({ maxRooms: 2 });
    store.create('Host', '10.0.0.1');
    store.create('Host', '10.0.0.2');
    clock.t += 4 * 60 * 1000;
    expectError(() => store.create('Host', '10.0.0.3'), 503, 'capacity');
  });

  test('activity extends the TTL', () => {
    const { store, clock } = makeStore();
    const { code } = store.create('Host', '1.1.1.1');
    store.join(code, 'Ana');
    clock.t += 90 * 60 * 1000;
    store.join(code, 'Bob');
    clock.t += 90 * 60 * 1000;
    assert.deepEqual(store.expire(), []);
  });

  test('an expired room is not found on lookup even before the sweep', () => {
    const { store, clock, expired } = makeStore();
    const { code } = store.create('Host', '1.1.1.1');
    clock.t += 3 * 60 * 60 * 1000;
    expectError(() => store.join(code, 'Ana'), 404, 'room_not_found');
    assert.deepEqual(expired, [code]);
  });

  test('global room cap answers 503 capacity', () => {
    const { store } = makeStore({ maxRooms: 3 });
    for (let i = 0; i < 3; i += 1) store.create('Host', `10.0.0.${i}`);
    expectError(() => store.create('Host', '10.0.0.99'), 503, 'capacity');
  });

  test('global cap frees up when old rooms expire', () => {
    const { store, clock } = makeStore({ maxRooms: 1 });
    store.create('Host', '10.0.0.1');
    clock.t += 3 * 60 * 60 * 1000;
    assert.ok(store.create('Host', '10.0.0.2').code);
  });

  test('per-IP creation limit: 5 per hour', () => {
    const { store, clock } = makeStore();
    for (let i = 0; i < 5; i += 1) store.create('Host', '1.2.3.4');
    expectError(() => store.create('Host', '1.2.3.4'), 429, 'rate_limited');
    assert.ok(store.create('Host', '5.6.7.8').code);
    clock.t += 60 * 60 * 1000 + 1;
    assert.ok(store.create('Host', '1.2.3.4').code);
  });

  test('invalid names do not consume the per-IP quota', () => {
    const { store } = makeStore();
    for (let i = 0; i < 10; i += 1) assert.throws(() => store.create('', '1.2.3.4'));
    assert.ok(store.create('Host', '1.2.3.4').code);
  });

  test('codes do not collide', () => {
    const { store } = makeStore({ maxRooms: 1000, roomsPerIpPerWindow: 1000 });
    const codes = new Set<string>();
    for (let i = 0; i < 200; i += 1) codes.add(store.create('Host', '1.1.1.1').code);
    assert.equal(codes.size, 200);
  });
});

describe('played vote ("Ya lo jugué")', () => {
  const tally = (gameId: string, likes: number, nopes: number, played: number, playedOut: boolean, match = false) =>
    ({ gameId, likes, superlikes: 0, superlikedBy: [] as string[], nopes, played, playedOut, match });

  test('is accepted, changeable and clearable like like/nope, and stays private while the card is open', () => {
    const r = votingRoom();
    const snap = r.store.vote(r.code, r.ana.playerToken, 'a', 'played');
    assert.deepEqual(snap.currentVoters, [r.ana.playerId]);
    assert.equal(snap.votes.a, undefined);
    assert.equal(r.store.currentVote(r.code, r.ana.playerToken).vote, 'played');
    r.store.vote(r.code, r.ana.playerToken, 'a', 'like');
    assert.equal(r.store.currentVote(r.code, r.ana.playerToken).vote, 'like');
    r.store.vote(r.code, r.ana.playerToken, 'a', 'played');
    const cleared = r.store.vote(r.code, r.ana.playerToken, 'a', null);
    assert.deepEqual(cleared.currentVoters, []);
    assert.equal(r.store.currentVote(r.code, r.ana.playerToken).vote, null);
  });

  test('rejects any other value without changing the room', () => {
    const r = votingRoom();
    const version = r.store.snapshot(r.code).version;
    for (const bad of ['skip', 'PLAYED', 1, true, undefined, {}]) {
      expectError(() => r.store.vote(r.code, r.ana.playerToken, 'a', bad), 400, 'invalid_vote');
    }
    assert.equal(r.store.snapshot(r.code).version, version);
  });

  test('counts toward auto-advance', () => {
    const r = votingRoom();
    r.store.vote(r.code, r.host.playerToken, 'a', 'played');
    r.store.vote(r.code, r.ana.playerToken, 'a', 'nope');
    const snap = r.store.vote(r.code, r.bob.playerToken, 'a', 'like');
    assert.equal(snap.index, 1);
    assert.deepEqual(snap.lastResult, tally('a', 1, 1, 1, false));
  });

  test('playedOut needs a strict majority of the votes cast: 2/3 yes, 1/2 no, 1/1 yes', () => {
    const r = votingRoom();
    r.store.vote(r.code, r.host.playerToken, 'a', 'played');
    r.store.vote(r.code, r.ana.playerToken, 'a', 'played');
    assert.deepEqual(r.store.vote(r.code, r.bob.playerToken, 'a', 'like').lastResult, tally('a', 1, 0, 2, true));

    r.store.vote(r.code, r.host.playerToken, 'b', 'played');
    r.store.vote(r.code, r.ana.playerToken, 'b', 'like');
    assert.deepEqual(r.store.next(r.code, r.host.hostToken).lastResult, tally('b', 1, 0, 1, false), '1 of 2 is not a majority');

    r.store.vote(r.code, r.bob.playerToken, 'c', 'played');
    assert.deepEqual(r.store.next(r.code, r.host.hostToken).lastResult, tally('c', 0, 0, 1, true), '1 of 1 is');
  });

  test('a card closed with no votes is not played out', () => {
    const r = votingRoom();
    assert.deepEqual(r.store.next(r.code, r.host.hostToken).lastResult, tally('a', 0, 0, 0, false));
  });

  test('never matches, even if every other player liked it', () => {
    const r = votingRoom();
    r.store.vote(r.code, r.host.playerToken, 'a', 'like');
    r.store.vote(r.code, r.ana.playerToken, 'a', 'like');
    const snap = r.store.vote(r.code, r.bob.playerToken, 'a', 'played');
    assert.equal(snap.results.a.match, false);
    assert.equal(snap.results.a.playedOut, false);
  });

  test('closed votes keep the value in the snapshot; results stay frozen after joins and kicks', () => {
    const r = votingRoom();
    r.store.vote(r.code, r.host.playerToken, 'a', 'played');
    r.store.vote(r.code, r.ana.playerToken, 'a', 'played');
    r.store.vote(r.code, r.bob.playerToken, 'a', 'nope');
    r.store.join(r.code, 'Late');
    r.store.kick(r.code, r.host.hostToken, r.bob.playerId);
    const snap = r.store.snapshot(r.code);
    assert.equal(snap.votes.a[r.ana.playerId], 'played');
    assert.deepEqual(snap.results.a, tally('a', 0, 1, 2, true));
  });

  test('undo after a played-out close reopens the card cleanly', () => {
    const r = votingRoom();
    r.store.vote(r.code, r.host.playerToken, 'a', 'played');
    r.store.vote(r.code, r.ana.playerToken, 'a', 'played');
    r.store.next(r.code, r.host.hostToken);
    const snap = r.store.undo(r.code, r.host.hostToken);
    assert.equal(snap.index, 0);
    assert.deepEqual(snap.results, {});
    assert.equal(snap.lastResult, null);
    assert.deepEqual(snap.currentVoters, []);
    assert.equal(r.store.currentVote(r.code, r.host.playerToken).vote, null);
  });

  test('kicking a player removes their played vote and can close the card', () => {
    const r = votingRoom();
    r.store.vote(r.code, r.host.playerToken, 'a', 'like');
    r.store.vote(r.code, r.ana.playerToken, 'a', 'played');
    const snap = r.store.kick(r.code, r.host.hostToken, r.bob.playerId);
    assert.equal(snap.index, 1, 'everyone left had voted');
    assert.deepEqual(snap.lastResult, tally('a', 1, 0, 1, false));
    const other = votingRoom();
    other.store.vote(other.code, other.bob.playerToken, 'a', 'played');
    const kicked = other.store.kick(other.code, other.host.hostToken, other.bob.playerId);
    assert.deepEqual(kicked.currentVoters, []);
    assert.equal(kicked.votes.a, undefined);
  });

  test('finish discards the open card played votes', () => {
    const r = votingRoom();
    r.store.vote(r.code, r.host.playerToken, 'a', 'played');
    const snap = r.store.finish(r.code, r.host.hostToken);
    assert.equal(snap.phase, 'finished');
    assert.deepEqual(snap.results, {});
    assert.equal(snap.votes.a, undefined);
    const resumed = r.store.undo(r.code, r.host.hostToken);
    assert.deepEqual(resumed.currentVoters, []);
  });
});

const MIN = 60 * 1000;

describe('presence-based cleanup (empty rooms)', () => {
  test('a room whose last stream disconnected is deleted after 10 min with nobody connected', () => {
    const { store, clock, expired, reasons } = makeStore();
    const { code } = store.create('Host', '1.1.1.1');
    store.join(code, 'Ana');
    store.setPresence(code, 2);
    store.setPresence(code, 0);
    clock.t += 10 * MIN;
    assert.deepEqual(store.expire(), [], 'exactly 10 min is still inside the window');
    clock.t += 1;
    assert.deepEqual(store.expire(), [code]);
    assert.deepEqual(expired, [code]);
    assert.deepEqual(reasons, ['empty']);
    expectError(() => store.snapshot(code), 404, 'room_not_found');
  });

  test('reconnecting within the window cancels the countdown', () => {
    const { store, clock } = makeStore();
    const { code } = store.create('Host', '1.1.1.1');
    store.join(code, 'Ana');
    store.setPresence(code, 1);
    store.setPresence(code, 0);
    clock.t += 9 * MIN;
    store.setPresence(code, 1);
    clock.t += 30 * MIN;
    assert.deepEqual(store.expire(), [], 'connected: only the 2 h idle TTL applies');
    store.setPresence(code, 0);
    clock.t += 10 * MIN + 1;
    assert.deepEqual(store.expire(), [code], 'the window restarts from the last disconnect');
  });

  test('a finished room is deleted 10 min after its last client left', () => {
    const { store, clock, reasons } = makeStore();
    const host = store.create('Host', '1.1.1.1');
    store.setPresence(host.code, 1);
    store.start(host.code, host.hostToken, FILTERS, () => ['a']);
    store.vote(host.code, host.hostToken, 'a', 'like');
    assert.equal(store.snapshot(host.code).phase, 'finished');
    clock.t += 60 * MIN;
    assert.deepEqual(store.expire(), [], 'still connected');
    store.setPresence(host.code, 0);
    clock.t += 10 * MIN + 1;
    assert.deepEqual(store.expire(), [host.code]);
    assert.deepEqual(reasons, ['empty']);
  });

  test('a room that never had a connection keeps the lobby / 2 h TTLs', () => {
    const { store, clock, reasons } = makeStore();
    const { code } = store.create('Host', '1.1.1.1');
    store.join(code, 'Ana');
    store.setPresence(code, 0); // a 0 report without a prior connection starts nothing
    clock.t += 11 * MIN;
    assert.deepEqual(store.expire(), []);
    clock.t += 2 * 60 * MIN;
    assert.deepEqual(store.expire(), [code]);
    assert.deepEqual(reasons, ['idle']);
  });

  test('presence is not a mutation and unknown codes are ignored', () => {
    const { store } = makeStore();
    const { code } = store.create('Host', '1.1.1.1');
    const version = store.snapshot(code).version;
    store.setPresence(code, 3);
    store.setPresence('ZZZZZZ', 0);
    assert.equal(store.snapshot(code).version, version);
  });

  test('the window is configurable', () => {
    const { store, clock } = makeStore({ emptyRoomTtlMs: 1000 });
    const { code } = store.create('Host', '1.1.1.1');
    store.setPresence(code, 1);
    store.setPresence(code, 0);
    clock.t += 1001;
    expectError(() => store.snapshot(code), 404, 'room_not_found');
  });
});

describe('host closes the room', () => {
  test('close deletes the room immediately with reason closed_by_host', () => {
    const { store, expired, reasons } = makeStore();
    const host = store.create('Host', '1.1.1.1');
    const ana = store.join(host.code, 'Ana');
    store.close(host.code, host.hostToken);
    assert.deepEqual(expired, [host.code]);
    assert.deepEqual(reasons, ['closed_by_host']);
    assert.equal(store.size, 0);
    expectError(() => store.snapshot(host.code), 404, 'room_not_found');
    expectError(() => store.currentVote(host.code, ana.playerToken), 404, 'room_not_found');
  });

  test('a non-host gets 403 not_host, no token or a foreign token 401; the room survives', () => {
    const { store, expired } = makeStore();
    const host = store.create('Host', '1.1.1.1');
    const other = store.create('Other', '1.1.1.2');
    const ana = store.join(host.code, 'Ana');
    expectError(() => store.close(host.code, ana.playerToken), 403, 'not_host');
    expectError(() => store.close(host.code, null), 401, 'unauthorized');
    expectError(() => store.close(host.code, other.hostToken), 401, 'unauthorized');
    expectError(() => store.close('ZZZZZZ', host.hostToken), 404, 'room_not_found');
    assert.deepEqual(expired, []);
    assert.equal(store.snapshot(host.code).players.length, 2);
  });
});

describe('member view vs public view', () => {
  test('members get the snapshot; no token or a foreign token gets only code/phase/counts', () => {
    const { store } = makeStore();
    const host = store.create('Host', '1.1.1.1');
    const other = store.create('Other', '1.1.1.2');
    const ana = store.join(host.code, 'Ana');
    assert.deepEqual(store.view(host.code, ana.playerToken), store.snapshot(host.code));
    assert.deepEqual(store.view(host.code, host.hostToken), store.snapshot(host.code));
    const expected = { code: host.code, phase: 'lobby', playerCount: 2, maxPlayers: 12 };
    assert.deepEqual(store.view(host.code, null), expected);
    assert.deepEqual(store.view(host.code, other.hostToken), expected);
    assert.deepEqual(store.view(host.code, 'garbage'), expected);
  });

  test('playerId / hasPlayer bind tickets to a member and notice kicks', () => {
    const { store } = makeStore();
    const host = store.create('Host', '1.1.1.1');
    const ana = store.join(host.code, 'Ana');
    assert.equal(store.playerId(host.code, ana.playerToken), ana.playerId);
    expectError(() => store.playerId(host.code, null), 401, 'unauthorized');
    assert.equal(store.hasPlayer(host.code, ana.playerId), true);
    store.kick(host.code, host.hostToken, ana.playerId);
    assert.equal(store.hasPlayer(host.code, ana.playerId), false);
    assert.equal(store.hasPlayer('ZZZZZZ', ana.playerId), false);
  });
});
