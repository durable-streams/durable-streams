# 1 Million Boxes — Full Spec

## 1) Summary

A global, finite, realtime game of Dots & Boxes on a **1000×1000** grid (1,000,000 boxes). Four teams (**Red / Blue / Green / Yellow**) race to claim the most boxes. Players place edges. A box is claimed by the team that places the **final (4th) edge** completing it.

**Authoritative state** is the **Durable Stream log** of accepted edge placements. Everything else is derived.

---

## 2) Goals and Non-Goals

### Goals

- Viral, extremely simple: “click lines, complete squares”.
- Global “single world” experience (one shared board per active game).
- Deterministic outcomes from a compact append-only log.
- Efficient storage: events are **3 bytes each**.
- Client computes:
  - box ownership
  - team scores
  - rendering (including zoomed-out view)

- Server enforces:
  - edge uniqueness (cannot place an already-set edge)
  - rate limiting (Cloudflare rate limiting)

- Supports multiple games over time:
  - one “current game”
  - old games remain replayable (log persists)

### Non-Goals (v1)

- Perfect anti-cheat / identity enforcement (no hard accounts required).
- Server-side score calculation / leaderboards (optional future).
- Sharded DO architecture (single writer DO for v1).

---

## 3) Game Rules

### Board

- Boxes: **W=1000, H=1000** (1,000,000 boxes)
- Players place **edges**, not boxes.

### Teams

- 4 teams: `RED, BLUE, GREEN, YELLOW`
- Team is assigned on first visit and stored in a **signed cookie**.

### Moves

- A move is: “place edge `edgeId`”.
- If the edge is already placed, the move is rejected.

### Claiming a box

- A box is claimed by the team who places the **last edge** completing it.
- No turn order. No extra moves. Fully concurrent.

### Winning

- Game ends when all edges are placed (equivalently all boxes are completable; in practice boxes will all be claimed by that point).
- Winning team: highest number of claimed boxes.
- Tie: allowed (display tie).

---

## 4) Identifiers and Coordinate System

## 4.1 Edge indexing (canonical)

Total edges:

- Horizontal edges: `W * (H+1)` = `1000 * 1001` = **1,001,000**
- Vertical edges: `(W+1) * H` = `1001 * 1000` = **1,001,000**
- Total: **2,002,000** edges

Define:

### Horizontal edge at (x, y)

- `x ∈ [0 .. W-1]`
- `y ∈ [0 .. H]` (note H+1 rows of horizontal edges)
- `edgeId = y*W + x`
- Range: `[0 .. HORIZ_COUNT-1]`

Where `HORIZ_COUNT = W*(H+1)`.

### Vertical edge at (x, y)

- `x ∈ [0 .. W]`
- `y ∈ [0 .. H-1]`
- `edgeId = HORIZ_COUNT + y*(W+1) + x`
- Range: `[HORIZ_COUNT .. HORIZ_COUNT+VERT_COUNT-1]`

Where `VERT_COUNT = (W+1)*H`.

### Helpers

- `isHorizontal(edgeId) = edgeId < HORIZ_COUNT`

And inverse mapping for rendering/picking edges is straightforward.

---

## 4.2 Box indexing (client-derived)

Box at (x, y):

- `x ∈ [0 .. W-1]`
- `y ∈ [0 .. H-1]`
- `boxId = y*W + x` (0..999,999)

Edges around a box:

- `top    = h(x,y)   = (y)*W + x`
- `bottom = h(x,y+1) = (y+1)*W + x`
- `left   = v(x,y)   = HORIZ_COUNT + y*(W+1) + x`
- `right  = v(x+1,y) = HORIZ_COUNT + y*(W+1) + (x+1)`

A box is complete iff all four edges are set.

---

## 5) Event Log Format (Durable Stream)

## 5.1 Event representation

Each accepted move becomes one fixed-size record:

- `packed24 = (edgeId << 2) | teamId`
  - `edgeId` fits in 21 bits (max ~2,002,000)
  - `teamId` fits in 2 bits (0..3)

Record size: **3 bytes** (24 bits), big-endian.

### Team IDs

- `0 = RED`
- `1 = BLUE`
- `2 = GREEN`
- `3 = YELLOW`

### Stream bytes

The stream is a concatenation of 3-byte records:

```
[ b0 b1 b2 ][ b0 b1 b2 ][ b0 b1 b2 ]...
```

**Readers must handle chunk boundaries** (i.e., buffer partial records if they read a non-multiple-of-3 chunk).

## 5.2 Storage size sanity check

If the game reaches full completion (all edges placed):

- events ≈ 2,002,000
- bytes ≈ 2,002,000 \* 3 = **~6.0 MB** (+ minor framing)

---

## 6) Cloudflare Architecture

## 6.1 Components

1. **Worker** (HTTP entry)

- Serves static UI assets (or via Pages)
- Provides API endpoints (see below)
- Applies **Cloudflare rate limiting** to draw endpoint
- Routes draw requests to the game DO

2. **Durable Object: GameWriterDO(gameId)**

- Single writer / coordinator for a game:
  - keeps **edge availability bitset in memory**
  - validates “edge not already set”
  - appends accepted moves to the Durable Stream
  - updates in-memory bitset and counters

- On DO startup:
  - fully replays the stream to rebuild bitset before accepting writes

3. **Durable Stream: `boxes/{gameId}/edges`**

- Authoritative append-only log of accepted edges (3 bytes each)
- Public read (spectator), write only via DO

4. **Game Registry**
   Minimal mechanism to support multiple games:

- A tiny KV/D1 record (or a small “registry DO”) that stores:
  - `currentGameId`
  - metadata list for past games

(Registry is not on the hot path; it’s admin/UX glue.)

---

## 6.2 In-memory edge availability

In the DO:

- `edgeTaken = Uint8Array(ceil(EDGE_COUNT/8))`
- EDGE_COUNT = 2,002,000
- size ≈ 250,250 bytes

Operations:

- `get(edgeId)`:
  - `i = edgeId >> 3`
  - `m = 1 << (edgeId & 7)`
  - taken = `(edgeTaken[i] & m) !== 0`

- `set(edgeId)`:
  - `edgeTaken[i] |= m`

The DO may also track:

- `edgesPlacedCount` (integer)
- `ready` flag (boot barrier)

---

## 6.3 Boot barrier

On DO start:

1. `ready=false`
2. Read stream from offset 0
3. For each record: set bit in bitset
4. Set `edgesPlacedCount`
5. `ready=true`

Until `ready=true`, draw requests return:

- `503 { code: "WARMING_UP" }`

(You said full replay is fine; this just prevents accepting stale writes during warm-up.)

---

## 6.4 Rate limiting (server enforcement)

Use **Cloudflare rate limiting** on `POST /games/:id/draw` (Worker-level).

Recommended key:

- `ip + team + gameId`
- Team comes from signed cookie.
- This prevents one IP from spamming a single team (and also avoids cross-game leakage).

Limit policy:

- Hard limit: **10 moves / minute**
- Burst: optional (e.g. allow short burst then recover)

On rate limit breach:

- 429 response returned before DO call.

---

## 7) Client “Simulated Quota”

Client displays a local quota counter that is slightly conservative, e.g.:

- UI shows “8 per minute” while server enforces 10/min.

Rules:

- UI decrements locally on click to feel responsive.
- If server returns 429 or edge-taken, UI corrects.
- UI may “refill” on a timer (purely cosmetic).

(You’re explicitly OK with this being approximate.)

---

## 8) APIs

### 8.1 Public game discovery

#### `GET /games/current`

Returns metadata for the current game.

```json
{
  "gameId": "01J…",
  "status": "ACTIVE",
  "w": 1000,
  "h": 1000,
  "stream": "boxes/{gameId}/edges",
  "startedAt": "2026-01-22T12:00:00Z"
}
```

#### `GET /games`

List all games (active + finished).

```json
[
  { "gameId": "…", "status": "ACTIVE", "startedAt": "…" },
  { "gameId": "…", "status": "FINISHED", "startedAt": "…", "finishedAt": "…" }
]
```

#### `GET /games/:gameId`

Returns metadata for a specific game.

---

### 8.2 Team allocation

#### `GET /team`

Returns your assigned team and sets a **signed cookie** if missing.

```json
{ "team": "RED" }
```

Cookie fields (conceptual):

- `teamId` (0..3)
- signature (HMAC)

---

### 8.3 Draw an edge

#### `POST /games/:gameId/draw`

Request:

```json
{ "edgeId": 1234567 }
```

Responses:

- `200 OK` (accepted)

```json
{ "ok": true }
```

- `409 Conflict` (edge already taken)

```json
{ "ok": false, "code": "EDGE_TAKEN" }
```

- `503 Service Unavailable` (DO warming up)

```json
{ "ok": false, "code": "WARMING_UP" }
```

- `429 Too Many Requests` (rate limited by Cloudflare)

```json
{ "ok": false, "code": "RATE_LIMITED" }
```

Notes:

- The server determines `teamId` from cookie; clients do not send it.
- On accept, DO appends `(edgeId, teamId)` to the stream.

---

### 8.4 Read the event log (spectators + clients)

You’ll expose a read endpoint that proxies Durable Streams (or you serve stream reads directly if your platform supports it):

#### `GET /games/:gameId/edges?fromRecord=N`

Returns a binary body containing concatenated 3-byte records starting at record index N.

- Clients can:
  - fetch from 0 to full replay
  - then poll for new bytes
  - or upgrade to a streaming transport (SSE/WS) if you want live tailing

(Exact transport is implementation-defined; spec only requires “read from offset” support.)

---

## 9) Client State Derivation

Clients derive everything from the edge log in order.

### 9.1 Minimum client state

- `edgeTakenBitset` (same as server) — ~245 KiB
- `boxOwner = Uint8Array(W*H)` — 1,000,000 bytes
  - 0 = unclaimed
  - 1..4 = team owner

- Team scores: `score[4]` integers

### 9.2 Fold algorithm per event

For each record `(edgeId, teamId)` in log order:

1. If edge already set (shouldn’t happen if DO enforces uniqueness), ignore.
2. Set edge bit.
3. Determine candidate boxes adjacent to that edge:
   - If horizontal at (x,y): boxes at (x,y-1) and (x,y)
   - If vertical at (x,y): boxes at (x-1,y) and (x,y)

4. For each candidate box in bounds:
   - If `boxOwner[boxId] == 0` and all four edges are now set:
     - `boxOwner[boxId] = teamId+1`
     - `score[teamId]++`
     - update rendering/tile counters

This is O(1) per event and deterministic.

---

## 10) Rendering and “Fully Zoomed Out View”

### 10.1 Global view

A single canvas where **1 pixel = 1 box**:

- Canvas logical size: `1000×1000`
- Scale to fit viewport.
- When a box is claimed, set its pixel color to the team color.

This gives the “whole world at once” view immediately and is cheap.

### 10.2 Zoom-in view

When user zooms:

- Render dots + edges for visible region only
- Show edge hover target and click-to-place
- Optional: show claimed boxes fill under the grid

### 10.3 Live updates

As events stream in:

- Update derived state incrementally
- Update pixels incrementally
- Update scores incrementally

---

## 11) Game Lifecycle and Multiple Games

### 11.1 Game states

- `ACTIVE`: accepts draws
- `FINISHED`: read-only (draw returns 410 or 409 + code)
- `ARCHIVED`: same as finished; purely a labeling choice

### 11.2 Creating a new game

Admin-only endpoint:

#### `POST /admin/games`

Creates a new game:

- assigns `gameId` (ULID recommended)
- creates durable stream `boxes/{gameId}/edges` (empty)
- creates/initializes DO instance keyed by `gameId` (optional eager warm)
- updates registry:
  - sets `currentGameId = newGameId`
  - marks old current game as `FINISHED` (if desired)

Returns game metadata.

### 11.3 Finishing a game

Admin-only endpoint:

#### `POST /admin/games/:gameId/finish`

Marks game as finished in registry and prevents further draws.

Server-side finish condition (v1, simple):

- DO can also auto-finish when `edgesPlacedCount == EDGE_COUNT`
- If you do auto-finish, DO calls registry update.

### 11.4 Accessing old games

Old games remain replayable:

- Clients load `/games/:gameId`
- Fetch edge log from record 0 (or support `fromRecord`)
- Recompute box owners and final scores client-side

### 11.5 Share links and replay

Share URLs:

- `/g/:gameId` – watch from the start
- `/g/:gameId?atRecord=N` – “rewind to this moment”
  - client replays from 0 to N (or uses range fetches)

- Optional: a timeline scrubber that changes `atRecord`

---

## 12) Operational Notes

### 12.1 Single DO limits (v1)

A single writer DO serializes all accepted edges. This is fine for launch but is your main scaling bottleneck if truly viral. (Sharding is a v2 path.)

### 12.2 Abuse controls (minimal)

- Signed team cookie
- Cloudflare rate limiting
- Optional: basic bot gate (Turnstile) on draw endpoint if needed

---

## 13) Future Extensions (designed-in hooks)

- **Sharded writer DOs** by region if needed.
- **Server-derived aggregates** (tiles, scores) if client computation becomes too heavy on low-end devices.
- Individual accounts and per-user leaderboards (requires including userId in events, or a secondary claim log).
- Snapshots for instant join (not required if you’re happy with full replay).
