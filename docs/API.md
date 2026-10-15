# ¿Qué Jugamos? v2 — API contract

Source of truth shared by backend and frontend. Change it only with both sides updated in the same PR.

## Concepts

- **Room**: one voting night. Identified by `code` (6 chars, alphabet `23456789ABCDEFGHJKMNPQRSTUVWXYZ`, uppercase; lookups are case-insensitive).
- **Player**: `{ id, name, isHost }`. The host is also a player (created with the room).
- **Tokens**: `hostToken` and `playerToken` are opaque secrets (`crypto.randomUUID()`), sent as `Authorization: Bearer <token>`. Player `id` is public; tokens never appear in snapshots, events, logs or URLs.
- **Members**: whoever holds a valid token of THAT room (host or player). Names, votes, results and the deck are only for members: they are the only personal data the server keeps.
- **Phases**: `lobby` → `voting` → `finished`. The host can jump from `voting` to `finished` early (`finish`).
- **Deck**: list of `gameId` (the `id` field from `public/games.js`), filtered and shuffled **by the server** at start, so every client sees the same order.

## Public view (`GET /api/rooms/:code` without a member token)

```json
{ "code": "K7Q2MX", "phase": "voting", "playerCount": 4, "maxPlayers": 12 }
```

Enough for the join screen ("Sala K7Q2MX · 4 jugadores · votando"). A missing, invalid, kicked or other room's token gets this view, never a 401. Clients tell the two shapes apart by `players` (only in the snapshot).

## Snapshot (shape of `GET /api/rooms/:code` with a member token and of every SSE `state` event)

```json
{
  "code": "K7Q2MX",
  "phase": "voting",
  "players": [{ "id": "p_1a2b3c", "name": "Agus", "isHost": true }],
  "filters": { "platforms": ["PC"], "maxPrice": 20, "fitsGroup": true, "playerCount": null },
  "deck": ["valheim", "lethal-company"],
  "index": 1,
  "votes": { "valheim": { "p_1a2b3c": "like" } },
  "currentVoters": ["p_1a2b3c"],
  "lastResult": { "gameId": "valheim", "likes": 1, "nopes": 0, "played": 0, "playedOut": false, "match": true },
  "results": { "valheim": { "gameId": "valheim", "likes": 1, "nopes": 0, "played": 0, "playedOut": false, "match": true } },
  "version": 17
}
```

- `filters.maxPrice`: USD number or `null` (no limit). `filters` is `null` while in `lobby`.
- `filters.playerCount`: always present in the snapshot (`null` = automatic). See **Start filters**.
- `votes`: every **closed** card, `playerId -> "like" | "nope" | "played"`. The open card (`deck[index]` while `voting`) is never in `votes`: nobody, not even the host, sees who voted what until it closes.
- `currentVoters`: ids of the players who already voted on the open card (who, never what). Empty outside `voting`.
- `lastResult`: the card that was just closed (`null` until the first one). Clients use it for the swipe animation and the "IT'S A MATCH" overlay (`match` = every player liked it).
- `results`: every closed card, frozen when it closed (`undo` removes the reopened card). Use it for the ranking instead of recomputing from `votes`: players who join later must not change past results.
- After `undo` and after `finish`, `lastResult` is `null`.
- `phase: "finished"` with `index < deck.length` = the host finished early: `index` cards closed out of `deck.length`, and `deck[index]` was discarded (no `results` entry, its votes dropped). After the last card closes normally, `index === deck.length`.
- **`CardResult`** (`lastResult` and each `results` entry): `{ gameId, likes, nopes, played, playedOut, match }`. `played` = votes "ya lo jugué" on the card; `playedOut = played > (likes + nopes + played) / 2` (strict majority of the votes cast; a card closed with no votes is `false`). `match` = every player liked it, so any `played` vote means no match.
- `version`: increases by 1 on every change. Clients ignore snapshots with a version ≤ the one they have.

## Endpoints

All request bodies are JSON (`Content-Type: application/json`, max 1 KB). All errors are `{ "error": "<code>", "message": "<human text>" }`.

| Method | Path | Auth | Body | Success | Errors |
|---|---|---|---|---|---|
| POST | `/api/rooms` | — | `{ "hostName": string, "ref"?: string \| null, "viaGuest"?: boolean }` (see **Acquisition fields**) | `201 { code, hostToken, playerToken, playerId }` | 400 `invalid_name`, 400 `invalid_body`, 429 `rate_limited`, 503 `capacity` |
| GET | `/api/rooms/:code` | optional (member) | — | `200 Snapshot` with a member token, `200 PublicView` otherwise | 404 `room_not_found`, 429 `rate_limited` |
| POST | `/api/rooms/:code/join` | — | `{ "name": string }` | `201 { playerToken, playerId }` | 400 `invalid_name`, 404, 409 `name_taken`, 409 `room_full`, 409 `room_finished` |
| POST | `/api/rooms/:code/start` | host | `{ "filters": { platforms: string[], maxPrice: number \| null, playerCount?: number \| null, fitsGroup?: boolean } }` (see **Start filters**) | `200 Snapshot` | 400 `invalid_filters`, 401, 403 `not_host`, 409 `already_started`, 422 `empty_deck` |
| POST | `/api/rooms/:code/vote` | player | `{ "gameId": string, "vote": "like" \| "nope" \| "played" \| null }` | `200 Snapshot & { myVote }` — `myVote` (`"like" \| "nope" \| "played" \| null`): the caller's vote on the open card of the returned snapshot (`null` if none, e.g. the vote closed the card) | 400 `invalid_vote`, 401, 409 `not_current_game`, 409 `not_voting` |
| GET | `/api/rooms/:code/me` | player | — | `200 { playerId, gameId, vote }` — the caller's vote (`"like" \| "nope" \| "played"`) on the open card (`gameId`/`vote` `null` when there is none). Used to restore your own vote after a reload | 401, 404 |
| POST | `/api/rooms/:code/next` | host | `{}` | `200 Snapshot` (closes the current card even if votes are missing) | 401, 403, 409 `not_voting` |
| POST | `/api/rooms/:code/undo` | host | `{}` | `200 Snapshot` (reopens the previous card and clears its votes; after an early `finish`, reopens the discarded card instead) | 401, 403, 409 `nothing_to_undo` |
| POST | `/api/rooms/:code/finish` | host | `{}` | `200 Snapshot` (ends voting now; see Rules) | 401, 403 `not_host`, 409 `not_voting` (lobby or already finished) |
| POST | `/api/rooms/:code/kick` | host | `{ "playerId": string }` | `200 Snapshot` (removes the player; see Rules) | 400 `invalid_player`, 401, 403 `not_host`, 404 `player_not_found`, 409 `cannot_kick_host` |
| POST | `/api/rooms/:code/close` | host | `{}` | `200 { "closed": true }`: the room is deleted now (see Rules) | 401, 403 `not_host`, 404 |
| POST | `/api/rooms/:code/stream-ticket` | player | `{}` | `200 { "ticket": string }` (single use, 30 s, bound to room + player) | 401, 404 |
| GET | `/api/rooms/:code/events?ticket=<ticket>` | ticket | — | `text/event-stream` (`HEAD` also needs and consumes a ticket, answers the headers and ends without opening a stream) | 401 `unauthorized` (missing, malformed, expired, reused, other room's ticket, or the player was kicked; no stream opened), 404, 429, 503 `capacity` |
| GET | `/api/steam/:appId` | — | — | `200 SteamDetails` (see below; `stale: true` when served from an old cache entry) | 404 `unknown_game`, 429, 502 `steam_unavailable` (a failed app is not retried upstream for 120 s; after a Steam 429, no upstream calls for 60 s) |
| GET | `/healthz` | — | — | `200 { "ok": true }` | — |

`401 unauthorized` = missing or invalid token for this room. `vote: null` clears that player's vote.

**Abuse limits (any endpoint may answer them):**
- `429 rate_limited`: more than 600 API requests per minute from one client.
- `429 rate_limited` on every `/api/rooms/:code...` request: after 20 `room_not_found` answers in one minute from one client (code guessing). Lasts until the minute window resets, and applies to valid codes too.
- "One client" = its IP; for IPv6, its /64 prefix (an IPv4-mapped `::ffff:a.b.c.d` counts as the IPv4).
- `400 bad_request`: malformed URL, NUL byte in the path, invalid `Host`.
- `408` and connection closed: request headers + body not fully received within 10 s.

## Acquisition fields (`POST /api/rooms`)

Measurement only: they never change the response, are not stored in the room and are never echoed. The server writes them to the `room_created` log line (`ref`, `viaGuest`), which is the durable record (`scripts/metrics-from-logs.mjs` aggregates it per UTC day). Both are validated **before** the room is created, so a rejected request does not consume the per-client room quota.

- `ref`: traffic source, mapped to a closed list. Exact, case-sensitive match against `tt, ig, yt, x, rd, dc, twitch, wa, gh, qr, yo` → logged as is; any other string (including `""`) → `other`; absent or `null` → `direct`; any non-string → `400 invalid_body`.
- `viaGuest`: `true` when this browser previously joined someone else's room as a player (guest → host loop). Absent → `false`; anything other than a boolean → `400 invalid_body`.
- Client side: `?ref=<value>` on any page is lowercased, trimmed, cut to 32 chars, stored in `sessionStorage['quejugamos:ref']` and removed from the URL with `history.replaceState` (shared links don't carry it). A successful `join` sets `localStorage['quejugamos:wasGuest'] = '1'`; the client sends `viaGuest: true` only when that flag is set.

## Start filters

- `platforms`: a game passes if it shares at least one platform. `maxPrice`: USD or `null`; games with an unknown price always pass.
- `playerCount`: `null` or an integer 1–32, otherwise `400 invalid_filters`.
  - A number N keeps games that support N players online: `min <= N <= max` (`players` in `public/games.js`). The lobby's "5+" sends `5`.
  - `null` = automatic: the legacy `fitsGroup` rule with the room's current player count.
- `fitsGroup` (legacy, kept for older clients): `true` keeps games whose `max` >= players in the room (`min` is ignored).
- **Precedence:**
  1. `playerCount` is a number → it alone decides; `fitsGroup` is ignored.
  2. `playerCount` is `null` → `fitsGroup` decides; it is optional and defaults to `true` (send `false` to disable the size filter).
  3. `playerCount` absent (old clients) → `fitsGroup` is **required** (boolean), as before.
- The snapshot echoes the normalized filters: both `fitsGroup` and `playerCount` are always present.

**`SteamDetails`** (`/api/steam/:appId`):

```jsonc
{
  "name": string, "isFree": boolean,
  "price": { "final": number, "initial"?: number, "currency"?: string, "discount_percent"?: number } | null,
  "shortDescription": string, "header": string, "genres": string[], "categories": string[],
  "reviews": number | null, "metacritic": number | null, "releaseDate": string | null,
  "movies": Movie[],            // playable trailers, highlighted first, max 6 (may be [])
  "movie": Movie | null,        // = movies[0]; kept for older clients
  "screenshots": string[],      // full-size URLs, max 12
  "screenshotThumbs": string[]  // same order/length as screenshots (Steam thumbnails)
}
// Movie = { "name": string, "poster": string | null, "hls": string | null, "mp4": string | null } — at least one of hls/mp4 is set
```

Clients must tolerate a `stale: true` response from an older cache that has only `movie` and up to 4 `screenshots` (no `movies` / `screenshotThumbs`): fall back to `[movie]` and to the full-size URLs.

## Rules

- **Auto-advance**: when every player has voted (like, nope or played) on the current card, the server closes it (sets `lastResult`, `index += 1`). When `index === deck.length`, the phase becomes `finished`.
- A player who joins mid-voting votes starting from the current card.
- **"Ya lo jugué" (`vote: "played"`)**: a third vote value with the same lifecycle as like/nope: hidden while the card is open (only `currentVoters` shows who voted), changeable or clearable (`null`) until the card closes, and it counts toward auto-advance. Nothing is remembered across rooms. When the card closes, `playedOut` is computed once and frozen in `results` (see `CardResult`). Ranking rule for clients: cards with `playedOut: true` go in a separate "Ya jugados" group (not ranked, never a match); every other card ranks as usual, and a minority of `played` votes simply does not count as a like. Clients show "N lo jugaron" where `played > 0`. `POST /skip` no longer exists (`404`).
- **Finish early**: the host ends voting before the deck runs out. `phase` becomes `finished`; the open card is discarded (its votes, "played" included, are dropped and it gets no `results` entry); closed cards keep their frozen `results`; `lastResult` becomes `null` (no swipe replay); `version` increases. Clients show the normal ranking with "X of Y voted" (`index` of `deck.length`). `undo` right after it reopens that same card (`phase: voting`, same `index`, no votes), so a mis-tap is recoverable; a second `undo` reopens the previous closed card as usual. Logged as `game_finished_early` (`roomCode`, `closedCards`, `deckSize`; no names). The host UI calls this "Pausar y ver ranking": clients label the ranking "preliminar" while `index < deck.length`, list `deck.slice(index)` as "Sin votar", and the host resumes with `undo`. Clients can show a partial ranking at any time during `voting` from `results` alone (never recomputed from `votes`).
- **Unknown `filters` fields are ignored** (`parseFilters` reads only the documented ones), so an old client still sending `excludeGameIds` starts a normal room and the field has no effect.
- **Card log**: every card that closes logs `card_closed` (`roomCode`, `gameId`, `likes`, `nopes`, `played`, `playedOut`, `match`, `finished`; no names).
- **Kick**: the host removes a non-host player (a duplicate entry from another browser, someone who left). The player's token stops working (`401`), their vote on the current card (whatever its value) is deleted (closed cards keep their frozen `results`), `version` increases, and if every remaining player already voted the current card closes like an auto-advance (`match` = every remaining player liked it). A client whose `playerId` disappears from a snapshot was kicked: it clears its stored session and shows "El host te sacó de la sala".
- Names: trimmed (NFC), 1–16 chars. Rejected (`invalid_name`): control/format characters (zero-width, bidi marks, RLM), line/paragraph separators, Hangul fillers (U+3164, U+115F, U+1160, U+FFA0), more than 2 stacked combining marks, and names without at least one letter, digit or emoji. ZWJ is allowed only inside emoji sequences. Unique per room, compared after NFKC + lowercase with invisible code points removed (`ＡＧＵＳ` = `agus`). Cross-script look-alikes (Cyrillic `а` vs Latin `a`) are not detected.
- Limits: 12 players per room, 500 live rooms, 5 rooms created per client per hour, rooms expire after 2 h without activity. A lobby where only the host is present expires after 20 min idle; at the 500-room cap, the lone-host lobby idle the longest (at least 5 min) is evicted to make room.
- **Empty rooms**: a room that had at least one live SSE stream and now has none is deleted after 10 min with nobody connected (any phase). Reconnecting within the window cancels it. A room that never had a stream follows only the TTLs above.
- **Close**: the host deletes the room immediately. Every stream gets `event: closed` and ends; any later request for that code is `404 room_not_found`. Clients that receive `closed` clear their stored session and show "La sala se cerró".
- Every removal is logged as `room_expired` with `reason`: `idle` (TTL or capacity eviction), `empty` (nobody connected) or `closed_by_host`.

## SSE `/api/rooms/:code/events?ticket=...`

- `EventSource` can't send an `Authorization` header, so a member first trades its token for a ticket (`POST /stream-ticket`) and puts the ticket, never the token, in the URL. Tickets are 128 random bits (base64url), single use, valid 30 s, bound to (room, playerId); up to 4 outstanding per player. They are never logged by the app; a proxy access log may record the URL, which is why they are single use and short-lived.
- On connect the server immediately sends `event: state` with the full snapshot (this is the reconnection strategy: there are no diffs, the client always replaces its state).
- After that, one `event: state` on every change, plus a `: ping` comment every 25 s so proxies don't close the connection.
- When the room expires: `event: closed` and the server ends the stream.
- Caps: 50 streams per room, 20 per client, 2000 per server. Over a cap: `503 capacity` (JSON, no stream).
- A client that stops reading (more than 64 KB pending) is disconnected and reconnects with a fresh ticket, getting a fresh snapshot.
- **Reconnection is manual**: native `EventSource` auto-reconnect would reuse the URL, whose ticket is already spent (401). On `error` the client closes the `EventSource`, shows "reconectando…", and after a backoff (3 s doubling up to 30 s, reset on `open`) fetches `GET /api/rooms/:code` with its token (404 → "La sala se cerró"; public view → kicked) and connects again with a new ticket. A 401 from `stream-ticket` is retried once, then the session is treated as invalid.
- Live streams are the room's presence: see **Empty rooms**.
- **Deploy note**: this contract (tickets, member-only snapshot) shipped together on client and server. A tab opened before that deploy keeps reconnecting to the old ticketless URL (401) and needs a reload.

## SEO and crawler endpoints

- `GET /robots.txt` → `200 text/plain; charset=utf-8`: `User-agent: *`, `Allow: /`, `Sitemap: {PUBLIC_ORIGIN}/sitemap.xml`. Nothing is disallowed on purpose: crawlers must be able to fetch `/r/*` to see its `noindex`.
- `GET /sitemap.xml` → `200 application/xml; charset=utf-8` with a single URL: `{PUBLIC_ORIGIN}/`.
- Every response under `/r/*` and `/api/*` carries `X-Robots-Tag: noindex`.
- `index.html` (served for `/`, `/index.html` and `/r/:code`) is rendered at serve time: `canonical`, `og:url`, `og:image`, `twitter:image` and the JSON-LD `url` use the absolute `PUBLIC_ORIGIN` (never the request's `Host`), and the `google-site-verification` / `msvalidate.01` meta tags appear only when their env vars are set and valid.

## Frontend routes (the server serves `public/index.html` for these)

- `/` — landing: create a room (host name) or join with a code.
- `/r/:code` — the room. No token in `localStorage['quejugamos:room:<CODE>']` (or a token the server no longer accepts) → join form built from the public view; a finished room shows "Votación terminada" instead (the ranking is for members). Host → host view (large card, QR, who already voted, "Cerrar sala"). Others → phone view.
