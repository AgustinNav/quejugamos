# ¿Qué Jugamos? v2 — API contract

Source of truth shared by backend and frontend. Change it only with both sides updated in the same PR.

## Concepts

- **Room**: one voting night. Identified by `code` (6 chars, alphabet `23456789ABCDEFGHJKMNPQRSTUVWXYZ`, uppercase; lookups are case-insensitive).
- **Player**: `{ id, name, isHost }`. The host is also a player (created with the room).
- **Tokens**: `hostToken` and `playerToken` are opaque secrets (`crypto.randomUUID()`), sent as `Authorization: Bearer <token>`. Player `id` is public; tokens never appear in snapshots or events.
- **Phases**: `lobby` → `voting` → `finished`.
- **Deck**: list of `gameId` (the `id` field from `public/games.js`), filtered and shuffled **by the server** at start, so every client sees the same order.

## Snapshot (shape of `GET /api/rooms/:code` and of every SSE `state` event)

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
  "lastResult": { "gameId": "valheim", "likes": 1, "nopes": 0, "match": true },
  "results": { "valheim": { "gameId": "valheim", "likes": 1, "nopes": 0, "match": true } },
  "version": 17
}
```

- `filters.maxPrice`: USD number or `null` (no limit). `filters` is `null` while in `lobby`.
- `filters.playerCount`: always present in the snapshot (`null` = automatic). See **Start filters**.
- `votes`: every **closed** card, `playerId -> "like" | "nope"`. The open card (`deck[index]` while `voting`) is never in `votes`: nobody, not even the host, sees who voted what until it closes.
- `currentVoters`: ids of the players who already voted on the open card (who, never what). Empty outside `voting`.
- `lastResult`: the card that was just closed (`null` until the first one). Clients use it for the swipe animation and the "IT'S A MATCH" overlay (`match` = every player liked it).
- `results`: every closed card, frozen when it closed (`undo` removes the reopened card). Use it for the ranking instead of recomputing from `votes`: players who join later must not change past results.
- After `undo`, `lastResult` is `null`.
- A card closed by `skip` ("Ya lo jugamos") has `played: true` and `skippedBy: playerId` in `lastResult`/`results`, with `likes: 0, nopes: 0, match: false` (its votes are discarded). Other results don't carry these fields.
- `version`: increases by 1 on every change. Clients ignore snapshots with a version ≤ the one they have.

## Endpoints

All request bodies are JSON (`Content-Type: application/json`, max 1 KB; 16 KB for `start`, which may carry `excludeGameIds`). All errors are `{ "error": "<code>", "message": "<human text>" }`.

| Method | Path | Auth | Body | Success | Errors |
|---|---|---|---|---|---|
| POST | `/api/rooms` | — | `{ "hostName": string }` | `201 { code, hostToken, playerToken, playerId }` | 400 `invalid_name`, 429 `rate_limited`, 503 `capacity` |
| GET | `/api/rooms/:code` | — | — | `200 Snapshot` | 404 `room_not_found`, 429 `rate_limited` |
| POST | `/api/rooms/:code/join` | — | `{ "name": string }` | `201 { playerToken, playerId }` | 400 `invalid_name`, 404, 409 `name_taken`, 409 `room_full`, 409 `room_finished` |
| POST | `/api/rooms/:code/start` | host | `{ "filters": { platforms: string[], maxPrice: number \| null, playerCount?: number \| null, fitsGroup?: boolean } }` (see **Start filters**) | `200 Snapshot` | 400 `invalid_filters`, 401, 403 `not_host`, 409 `already_started`, 422 `empty_deck` |
| POST | `/api/rooms/:code/vote` | player | `{ "gameId": string, "vote": "like" \| "nope" \| null }` | `200 Snapshot & { myVote }` — `myVote`: the caller's vote on the open card of the returned snapshot (`null` if none, e.g. the vote closed the card) | 400 `invalid_vote`, 401, 409 `not_current_game`, 409 `not_voting` |
| GET | `/api/rooms/:code/me` | player | — | `200 { playerId, gameId, vote }` — the caller's vote on the open card (`gameId`/`vote` `null` when there is none). Used to restore your own vote after a reload | 401, 404 |
| POST | `/api/rooms/:code/next` | host | `{}` | `200 Snapshot` (closes the current card even if votes are missing) | 401, 403, 409 `not_voting` |
| POST | `/api/rooms/:code/skip` | player | `{ "gameId": string }` | `200 Snapshot` (closes the current card as already played; see Rules) | 400 `invalid_game`, 401, 409 `not_current_game`, 409 `not_voting` |
| POST | `/api/rooms/:code/undo` | host | `{}` | `200 Snapshot` (reopens the previous card and clears its votes) | 401, 403, 409 `nothing_to_undo` |
| POST | `/api/rooms/:code/kick` | host | `{ "playerId": string }` | `200 Snapshot` (removes the player; see Rules) | 400 `invalid_player`, 401, 403 `not_host`, 404 `player_not_found`, 409 `cannot_kick_host` |
| GET | `/api/rooms/:code/events` | — | — | `text/event-stream` (`HEAD` answers the headers and ends, without opening a stream) | 404, 429, 503 `capacity` |
| GET | `/api/steam/:appId` | — | — | `200 SteamDetails` (see below; `stale: true` when served from an old cache entry) | 404 `unknown_game`, 429, 502 `steam_unavailable` (a failed app is not retried upstream for 120 s; after a Steam 429, no upstream calls for 60 s) |
| GET | `/healthz` | — | — | `200 { "ok": true }` | — |

`401 unauthorized` = missing or invalid token for this room. `vote: null` clears that player's vote.

**Abuse limits (any endpoint may answer them):**
- `429 rate_limited`: more than 600 API requests per minute from one client.
- `429 rate_limited` on every `/api/rooms/:code...` request: after 20 `room_not_found` answers in one minute from one client (code guessing). Lasts until the minute window resets, and applies to valid codes too.
- "One client" = its IP; for IPv6, its /64 prefix (an IPv4-mapped `::ffff:a.b.c.d` counts as the IPv4).
- `400 bad_request`: malformed URL, NUL byte in the path, invalid `Host`.
- `408` and connection closed: request headers + body not fully received within 10 s.

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

- **Auto-advance**: when every player has voted on the current card, the server closes it (sets `lastResult`, `index += 1`). When `index === deck.length`, the phase becomes `finished`.
- A player who joins mid-voting votes starting from the current card.
- **Skip ("Ya lo jugamos")**: any player (host included) closes the open card for the whole room through the same path as auto-advance: votes on it are discarded, `lastResult`/`results` get `{ gameId, likes: 0, nopes: 0, match: false, played: true, skippedBy }`, `version` increases, and the phase becomes `finished` if it was the last card. It never counts as a match. `undo` reopens it like any closed card (its `results` entry is removed). Logged as `card_skipped` (`roomCode`, `gameId`; no names). Clients show a "ya lo jugaron" toast/animation instead of LIKE/NOPE.
- **`filters.excludeGameIds`** (optional, `start` only): up to 200 catalog ids left out of the deck (the host's "ya jugados" memory, kept in the host browser's `localStorage['quejugamos:played']`). Every id must be a known catalog id, otherwise `400 invalid_filters`. Not stored in the room: snapshot `filters` never include it. Other filter fields are parsed independently.
- **Kick**: the host removes a non-host player (a duplicate entry from another browser, someone who left). The player's token stops working (`401`), their vote on the current card is deleted (closed cards keep their frozen `results`), `version` increases, and if every remaining player already voted the current card closes like an auto-advance (`match` = every remaining player liked it). A client whose `playerId` disappears from a snapshot was kicked: it clears its stored session and shows "El host te sacó de la sala".
- Names: trimmed (NFC), 1–16 chars. Rejected (`invalid_name`): control/format characters (zero-width, bidi marks, RLM), line/paragraph separators, Hangul fillers (U+3164, U+115F, U+1160, U+FFA0), more than 2 stacked combining marks, and names without at least one letter, digit or emoji. ZWJ is allowed only inside emoji sequences. Unique per room, compared after NFKC + lowercase with invisible code points removed (`ＡＧＵＳ` = `agus`). Cross-script look-alikes (Cyrillic `а` vs Latin `a`) are not detected.
- Limits: 12 players per room, 500 live rooms, 5 rooms created per client per hour, rooms expire after 2 h without activity. A lobby where only the host is present expires after 20 min idle; at the 500-room cap, the lone-host lobby idle the longest (at least 5 min) is evicted to make room.

## SSE `/api/rooms/:code/events`

- On connect the server immediately sends `event: state` with the full snapshot (this is the reconnection strategy: there are no diffs, the client always replaces its state).
- After that, one `event: state` on every change, plus a `: ping` comment every 25 s so proxies don't close the connection.
- When the room expires: `event: closed` and the server ends the stream.
- Caps: 50 streams per room, 20 per client, 2000 per server. Over a cap: `503 capacity` (JSON, no stream).
- A client that stops reading (more than 64 KB pending) is disconnected; `EventSource` reconnects and gets a fresh snapshot.
- The client uses the native `EventSource` (automatic reconnection).

## Frontend routes (the server serves `public/index.html` for these)

- `/` — landing: create a room (host name) or join with a code.
- `/r/:code` — the room. No token in `localStorage['quejugamos:room:<CODE>']` → join form. Host → host view (large card, QR, who already voted). Others → phone view.
