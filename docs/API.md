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
  "filters": { "platforms": ["PC"], "maxPrice": 20, "fitsGroup": true },
  "deck": ["lethal-company", "valheim"],
  "index": 0,
  "votes": { "lethal-company": { "p_1a2b3c": "like" } },
  "lastResult": { "gameId": "valheim", "likes": 3, "nopes": 0, "match": true },
  "results": { "valheim": { "gameId": "valheim", "likes": 3, "nopes": 0, "match": true } },
  "version": 17
}
```

- `filters.maxPrice`: USD number or `null` (no limit). `filters` is `null` while in `lobby`.
- `votes`: every voted card, `playerId -> "like" | "nope"`.
- `lastResult`: the card that was just closed (`null` until the first one). Clients use it for the swipe animation and the "IT'S A MATCH" overlay (`match` = every player liked it).
- `results`: every closed card, frozen when it closed (`undo` removes the reopened card). Use it for the ranking instead of recomputing from `votes`: players who join later must not change past results.
- After `undo`, `lastResult` is `null`.
- `version`: increases by 1 on every change. Clients ignore snapshots with a version ≤ the one they have.

## Endpoints

All request bodies are JSON (`Content-Type: application/json`, max 1 KB). All errors are `{ "error": "<code>", "message": "<human text>" }`.

| Method | Path | Auth | Body | Success | Errors |
|---|---|---|---|---|---|
| POST | `/api/rooms` | — | `{ "hostName": string }` | `201 { code, hostToken, playerToken, playerId }` | 400 `invalid_name`, 429 `rate_limited`, 503 `capacity` |
| GET | `/api/rooms/:code` | — | — | `200 Snapshot` | 404 `room_not_found`, 429 `rate_limited` |
| POST | `/api/rooms/:code/join` | — | `{ "name": string }` | `201 { playerToken, playerId }` | 400 `invalid_name`, 404, 409 `name_taken`, 409 `room_full`, 409 `room_finished` |
| POST | `/api/rooms/:code/start` | host | `{ "filters": { platforms: string[], maxPrice: number \| null, fitsGroup: boolean } }` | `200 Snapshot` | 400 `invalid_filters`, 401, 403 `not_host`, 409 `already_started`, 422 `empty_deck` |
| POST | `/api/rooms/:code/vote` | player | `{ "gameId": string, "vote": "like" \| "nope" \| null }` | `200 Snapshot` | 400 `invalid_vote`, 401, 409 `not_current_game`, 409 `not_voting` |
| POST | `/api/rooms/:code/next` | host | `{}` | `200 Snapshot` (closes the current card even if votes are missing) | 401, 403, 409 `not_voting` |
| POST | `/api/rooms/:code/undo` | host | `{}` | `200 Snapshot` (reopens the previous card and clears its votes) | 401, 403, 409 `nothing_to_undo` |
| GET | `/api/rooms/:code/events` | — | — | `text/event-stream` | 404, 429, 503 `capacity` |
| GET | `/api/steam/:appId` | — | — | `200` Steam details (unchanged from v1; `stale: true` when served from an old cache entry) | 404 `unknown_game`, 429, 502 `steam_unavailable` (a failed app is not retried upstream for 120 s; after a Steam 429, no upstream calls for 60 s) |
| GET | `/healthz` | — | — | `200 { "ok": true }` | — |

`401 unauthorized` = missing or invalid token for this room. `vote: null` clears that player's vote.

**Abuse limits (any endpoint may answer them):**
- `429 rate_limited`: more than 600 API requests per minute from one client.
- `429 rate_limited` on every `/api/rooms/:code...` request: after 20 `room_not_found` answers in one minute from one client (code guessing). Lasts until the minute window resets, and applies to valid codes too.
- "One client" = its IP; for IPv6, its /64 prefix (an IPv4-mapped `::ffff:a.b.c.d` counts as the IPv4).
- `400 bad_request`: malformed URL, NUL byte in the path, invalid `Host`.
- `408` and connection closed: request headers + body not fully received within 10 s.

## Rules

- **Auto-advance**: when every player has voted on the current card, the server closes it (sets `lastResult`, `index += 1`). When `index === deck.length`, the phase becomes `finished`.
- A player who joins mid-voting votes starting from the current card.
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
