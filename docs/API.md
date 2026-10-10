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
- `votes`: every **closed** card, `playerId -> "like" | "nope"`. The open card (`deck[index]` while `voting`) is never in `votes`: nobody, not even the host, sees who voted what until it closes.
- `currentVoters`: ids of the players who already voted on the open card (who, never what). Empty outside `voting`.
- `lastResult`: the card that was just closed (`null` until the first one). Clients use it for the swipe animation and the "IT'S A MATCH" overlay (`match` = every player liked it).
- `results`: every closed card, frozen when it closed (`undo` removes the reopened card). Use it for the ranking instead of recomputing from `votes`: players who join later must not change past results.
- After `undo`, `lastResult` is `null`.
- `version`: increases by 1 on every change. Clients ignore snapshots with a version ≤ the one they have.

## Endpoints

All request bodies are JSON (`Content-Type: application/json`, max 1 KB). All errors are `{ "error": "<code>", "message": "<human text>" }`.

| Method | Path | Auth | Body | Success | Errors |
|---|---|---|---|---|---|
| POST | `/api/rooms` | — | `{ "hostName": string }` | `201 { code, hostToken, playerToken, playerId }` | 400 `invalid_name`, 429 `rate_limited`, 503 `capacity` |
| GET | `/api/rooms/:code` | — | — | `200 Snapshot` | 404 `room_not_found` |
| POST | `/api/rooms/:code/join` | — | `{ "name": string }` | `201 { playerToken, playerId }` | 400 `invalid_name`, 404, 409 `name_taken`, 409 `room_full`, 409 `room_finished` |
| POST | `/api/rooms/:code/start` | host | `{ "filters": { platforms: string[], maxPrice: number \| null, fitsGroup: boolean } }` | `200 Snapshot` | 400 `invalid_filters`, 401, 403 `not_host`, 409 `already_started`, 422 `empty_deck` |
| POST | `/api/rooms/:code/vote` | player | `{ "gameId": string, "vote": "like" \| "nope" \| null }` | `200 Snapshot & { myVote }` — `myVote`: the caller's vote on the open card of the returned snapshot (`null` if none, e.g. the vote closed the card) | 400 `invalid_vote`, 401, 409 `not_current_game`, 409 `not_voting` |
| GET | `/api/rooms/:code/me` | player | — | `200 { playerId, gameId, vote }` — the caller's vote on the open card (`gameId`/`vote` `null` when there is none). Used to restore your own vote after a reload | 401, 404 |
| POST | `/api/rooms/:code/next` | host | `{}` | `200 Snapshot` (closes the current card even if votes are missing) | 401, 403, 409 `not_voting` |
| POST | `/api/rooms/:code/undo` | host | `{}` | `200 Snapshot` (reopens the previous card and clears its votes) | 401, 403, 409 `nothing_to_undo` |
| POST | `/api/rooms/:code/kick` | host | `{ "playerId": string }` | `200 Snapshot` (removes the player; see Rules) | 400 `invalid_player`, 401, 403 `not_host`, 404 `player_not_found`, 409 `cannot_kick_host` |
| GET | `/api/rooms/:code/events` | — | — | `text/event-stream` (`HEAD` answers the headers and ends, without opening a stream) | 404 |
| GET | `/api/steam/:appId` | — | — | `200` Steam details (unchanged from v1) | 404 `unknown_game`, 429, 502 |
| GET | `/healthz` | — | — | `200 { "ok": true }` | — |

`401 unauthorized` = missing or invalid token for this room. `vote: null` clears that player's vote.

## Rules

- **Auto-advance**: when every player has voted on the current card, the server closes it (sets `lastResult`, `index += 1`). When `index === deck.length`, the phase becomes `finished`.
- A player who joins mid-voting votes starting from the current card.
- **Kick**: the host removes a non-host player (a duplicate entry from another browser, someone who left). The player's token stops working (`401`), their vote on the current card is deleted (closed cards keep their frozen `results`), `version` increases, and if every remaining player already voted the current card closes like an auto-advance (`match` = every remaining player liked it). A client whose `playerId` disappears from a snapshot was kicked: it clears its stored session and shows "El host te sacó de la sala".
- Names: trimmed, 1–16 chars, no control characters, unique per room (case-insensitive).
- Limits: 12 players per room, 500 live rooms, 5 rooms created per IP per hour, rooms expire after 2 h without activity.

## SSE `/api/rooms/:code/events`

- On connect the server immediately sends `event: state` with the full snapshot (this is the reconnection strategy: there are no diffs, the client always replaces its state).
- After that, one `event: state` on every change, plus a `: ping` comment every 25 s so proxies don't close the connection.
- When the room expires: `event: closed` and the server ends the stream.
- The client uses the native `EventSource` (automatic reconnection).

## Frontend routes (the server serves `public/index.html` for these)

- `/` — landing: create a room (host name) or join with a code.
- `/r/:code` — the room. No token in `localStorage['quejugamos:room:<CODE>']` → join form. Host → host view (large card, QR, who already voted). Others → phone view.
