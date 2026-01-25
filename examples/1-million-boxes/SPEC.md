# 1 Million Boxes — Full Spec

## 1) Summary

A global, finite, realtime game of Dots & Boxes on a **1000×1000** grid (1,000,000 boxes). Four teams (**Red / Blue / Green / Yellow**) race to claim the most boxes. Players place edges. A box is claimed by the team that places the **final (4th) edge** completing it.

**Authoritative state** is the **Durable Stream log** of accepted edge placements. Everything else is derived.

---

## 1.1) Technology Stack

- **Frontend**: Vite + React (SPA)
- **UI Components**: [Base UI](https://base-ui.com) (unstyled, accessible components)
- **Styling**: Plain CSS (no Tailwind, no CSS-in-JS)
- **Runtime**: Cloudflare Workers (via [@cloudflare/vite-plugin](https://developers.cloudflare.com/workers/frameworks/framework-guides/vite/))
- **Backend**: Cloudflare Durable Objects
- **Real-time**: Durable Streams (long-poll via `@durable-streams/client`)
- **Rendering**: HTML Canvas (2D context)

Base UI provides:

- Accessible dialog/modal for game info, share links
- Tooltip for edge hover states and quota info
- Progress bar for quota meter

---

## 1.2) Development & Deployment

### Local Development

Use Wrangler's local dev server which simulates the Cloudflare Workers runtime including Durable Objects:

```bash
pnpm dev
```

This runs `vite dev` with the `@cloudflare/vite-plugin`, which:

- Simulates the Workers runtime locally
- Emulates Durable Objects with local persistence
- Uses the **local durable-streams server** from this repo for stream operations

### Durable Streams Configuration

| Environment | Durable Streams Server                                                |
| ----------- | --------------------------------------------------------------------- |
| Local dev   | Local server from `durable-streams` repo (localhost)                  |
| Production  | [ElectricSQL Cloud](https://electric-sql.com/) hosted Durable Streams |

Configure via environment variables:

```bash
# .dev.vars (local development)
DURABLE_STREAMS_URL=http://localhost:4437

# wrangler.jsonc (production - set via Cloudflare dashboard or wrangler secret)
# DURABLE_STREAMS_URL=https://your-project.electric-sql.com
```

### Vite Configuration

```typescript
// vite.config.ts
import { cloudflare } from "@cloudflare/vite-plugin"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [react(), cloudflare()],
})
```

### Wrangler Configuration

```jsonc
// wrangler.jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "1-million-boxes",
  "compatibility_date": "2025-01-22",
  "compatibility_flags": ["nodejs_compat"],
  "main": "worker/index.ts",

  // Durable Object binding for game state
  "durable_objects": {
    "bindings": [
      {
        "name": "GAME_WRITER",
        "class_name": "GameWriterDO",
      },
    ],
  },

  // Rate limiting
  "rate_limits": [
    {
      "name": "draw-limit",
      "period": 60,
      "limit": 10,
    },
  ],
}
```

### Package Scripts

```json
{
  "scripts": {
    "dev": "vite dev",
    "build": "vite build && tsc --noEmit",
    "preview": "vite preview",
    "deploy": "pnpm build && wrangler deploy",
    "cf-typegen": "wrangler types"
  }
}
```

### Deployment

```bash
# Login to Cloudflare (one-time)
pnpm dlx wrangler login

# Deploy to production
pnpm deploy
```

This deploys:

- Vite SPA assets served by the Worker
- GameWriterDO as a Durable Object
- Connects to ElectricSQL Cloud Durable Streams

---

## 2) Goals and Non-Goals

### Goals

- Viral, extremely simple: "click lines, complete squares".
- Global "single world" experience (one shared board per active game).
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
  - one "current game"
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

- A move is: "place edge `edgeId`".
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
  - `edgeId` range: 0..2,001,999 (fits in 21 bits; stored in the upper 22 bits of the 24-bit field)
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

1. **Worker App** (Cloudflare Worker)

- Serves SSR pages and static assets
- Provides API endpoints (see below)
- Applies **Cloudflare rate limiting** to draw endpoint
- Routes draw requests to the GameWriterDO

2. **Durable Object: GameWriterDO**

- Single writer / coordinator for the game:
  - keeps **edge availability bitset in memory**
  - validates "edge not already set"
  - appends accepted moves to the Durable Stream (via HTTP)
  - updates in-memory bitset and counters

- On DO startup:
  - fully replays the stream to rebuild bitset before accepting writes

3. **Durable Stream: `/game`** (External Service)

- **Local dev**: Durable Streams server from this repo (localhost:4437)
- **Production**: [ElectricSQL Cloud](https://electric-sql.com/) hosted Durable Streams

The Durable Stream is:

- Authoritative append-only log of accepted edges (3 bytes each)
- Public read (spectator) via long-polling through the Worker proxy
- Write only via GameWriterDO (HTTP POST)

**Note**: There is only one game at a time. The stream path is hardcoded. To start a new game, deploy with a fresh stream name or clear the existing stream.

### 6.1.1 Data Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                     Cloudflare Edge                              │
│  ┌─────────────────────┐    ┌─────────────────────────────────┐ │
│  │  Worker App         │    │  GameWriterDO                   │ │
│  │                     │───▶│  - edge bitset (250KB)          │ │
│  │  - static assets    │    │  - validates moves              │ │
│  │  - /api/draw        │    │  - appends to stream            │ │
│  │  - rate limiting    │    └───────────────┬─────────────────┘ │
│  └─────────────────────┘                    │ HTTP POST         │
└─────────────────────────────────────────────┼───────────────────┘
                                              │
                                              ▼
                            ┌─────────────────────────────────────┐
                            │  ElectricSQL Cloud                  │
                            │  Durable Streams                    │
                            │                                     │
                            │  Stream: /game                      │
                            │  - append-only log                  │
                            │  - long-poll for live tail          │
                            └─────────────────────────────────────┘
                                              ▲
                                              │ long-poll
                            ┌─────────────────┴─────────────────┐
                            │  Browser Clients                  │
                            │  - read stream via worker proxy   │
                            │  - derive game state locally      │
                            └───────────────────────────────────┘
```

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

## 7) Client Line Quota System

The client maintains a **local line quota** that is slightly more conservative than the server's Cloudflare rate limit. This provides immediate feedback and prevents most 429 errors.

### 7.1 Quota Parameters

| Parameter   | Client (UI)   | Server (CF) |
| ----------- | ------------- | ----------- |
| Max quota   | 8 lines       | 10 lines    |
| Refill rate | 1 line / 7.5s | 1 line / 6s |
| Burst       | 8             | 10          |

The client limit is intentionally ~20% stricter so users rarely hit the server limit.

### 7.2 localStorage Persistence

Quota state is persisted in `localStorage` under the key `boxes:quota`:

```json
{
  "remaining": 6,
  "lastRefillAt": 1706000000000,
  "version": 1
}
```

- `remaining`: current available lines (0–8)
- `lastRefillAt`: Unix timestamp (ms) of last refill calculation
- `version`: schema version for future migrations

On page load:

1. Read quota from localStorage
2. Calculate elapsed time since `lastRefillAt`
3. Add `floor(elapsed / 7500)` lines (capped at 8)
4. Update `lastRefillAt` to now minus remainder

If localStorage is missing or corrupt, initialize with full quota (8 lines).

### 7.3 Quota UI Display

Display quota as a visual indicator near the game controls:

```
┌─────────────────────────┐
│  Lines: ████████░░ 6/8  │
│         ↑ refill in 4s  │
└─────────────────────────┘
```

- **Progress bar**: filled segments = remaining quota
- **Numeric display**: `{remaining}/{max}`
- **Refill timer**: countdown to next line (updates every second)
- **Color coding**:
  - Green: 6–8 remaining
  - Yellow: 3–5 remaining
  - Red: 0–2 remaining

When quota is 0:

- Disable edge click/hover interactions
- Show "Recharging..." state
- Continue showing countdown timer

### 7.4 Quota Consumption Flow

On edge click:

1. Check `remaining > 0`
   - If no: show "Out of lines" toast, abort
2. Decrement `remaining` in memory and localStorage
3. Optimistically update UI (draw edge in pending state)
4. Send `POST /games/:gameId/draw`
5. Handle response:
   - `200 OK`: confirm edge placement
   - `409 EDGE_TAKEN`: revert UI, **refund 1 line** to quota
   - `429 RATE_LIMITED`: revert UI (don't refund—server says slow down)
   - `503 WARMING_UP`: revert UI, refund 1 line, show retry message

### 7.5 Quota Refill Logic

Run a refill check on an interval (every 1 second):

```typescript
function refillQuota() {
  const now = Date.now()
  const elapsed = now - state.lastRefillAt
  const linesToAdd = Math.floor(elapsed / 7500) // 7.5s per line

  if (linesToAdd > 0) {
    state.remaining = Math.min(8, state.remaining + linesToAdd)
    state.lastRefillAt += linesToAdd * 7500
    persistToLocalStorage(state)
  }
}
```

### 7.6 Cross-Tab Synchronization

Use the `storage` event to sync quota across tabs:

```typescript
window.addEventListener("storage", (e) => {
  if (e.key === "boxes:quota" && e.newValue) {
    state = JSON.parse(e.newValue)
    updateUI()
  }
})
```

This prevents users from opening multiple tabs to bypass quota.

---

## 8) APIs

There is only one active game per deployment. No game discovery APIs are needed—the frontend hardcodes the stream path.

### 8.1 Team allocation

Team assignment happens automatically on first visit and persists via a signed, HTTP-only cookie.

#### Assignment Flow

1. **On page load** (in app bootstrap):
   - Call `getTeam()` server function
   - Server checks for existing `team` cookie
2. **If cookie exists and valid**:
   - Verify HMAC signature
   - Return `{ team: "RED", teamId: 0 }`
3. **If cookie missing or invalid**:
   - Assign team using **round-robin with jitter**:
     - Fetch current team counts from a lightweight counter (KV or in-memory)
     - Assign to the team with fewest members
     - If tied, pick randomly among tied teams
   - Generate signed cookie
   - Set cookie and return team

#### `GET /team`

Returns your assigned team. Sets a **signed cookie** if missing.

```json
{ "team": "RED", "teamId": 0 }
```

#### Cookie Specification

```
Name: boxes_team
Value: <teamId>.<signature>
Example: 2.a1b2c3d4e5f6...

Attributes:
  HttpOnly: true
  Secure: true (production)
  SameSite: Lax
  Path: /
  Max-Age: 31536000 (1 year)
```

- `teamId`: 0–3 (RED=0, BLUE=1, GREEN=2, YELLOW=3)
- `signature`: HMAC-SHA256(teamId, SECRET_KEY), hex-encoded, truncated to 32 chars

#### Server-Side Verification

```typescript
function verifyTeamCookie(cookie: string, secret: string): number | null {
  const [teamIdStr, sig] = cookie.split(".")
  const teamId = parseInt(teamIdStr, 10)
  if (isNaN(teamId) || teamId < 0 || teamId > 3) return null

  const expected = hmacSha256(teamIdStr, secret).slice(0, 32)
  if (!timingSafeEqual(sig, expected)) return null

  return teamId
}
```

#### Client-Side Team Context

The team is provided to the React tree via context:

```typescript
// In __root.tsx loader
export const Route = createRootRoute({
  loader: async () => {
    const { team, teamId } = await getTeam()
    return { team, teamId }
  },
  component: RootComponent,
})

// TeamContext available throughout app
const { team, teamId } = Route.useLoaderData()
```

---

### 8.2 Draw an edge

#### `POST /draw`

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

### 8.3 Read the event log (spectators + clients)

Durable Streams supports streaming tails. The client should:

1. **Initial fetch**: `GET /game` to get all existing records
2. **Live tail**: Use long-poll streaming to receive new records as they're appended

#### `GET /game?fromRecord=N`

Returns a binary body containing concatenated 3-byte records starting at record index N.

For live streaming, the client can either:

- Use long-poll via the `@durable-streams/client`
- Poll with increasing `fromRecord` values

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

1. If edge already set (shouldn't happen if DO enforces uniqueness), ignore.
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

## 10) Rendering and Visual Design

The game has a **hand-drawn aesthetic**—like a Dots & Boxes game sketched on paper with colored pencils. This applies to both the main canvas and all UI elements.

---

### 10.1 Hand-Drawn Visual Style

#### Edges (Lines)

- Drawn with a slight **wobble/imperfection** using quadratic bezier curves with randomized control points
- Line thickness: 2–3px at normal zoom
- Unplaced edges: faint, dotted gray (like pencil guidelines)
- Placed edges: solid, team-colored, slightly thicker
- Pending edges (optimistic): pulsing/animated, semi-transparent

#### Dots (Vertices)

- Small filled circles at grid intersections
- Slightly irregular (not perfect circles)
- Dark gray/black, ~4px diameter at normal zoom

#### Claimed Boxes

- Filled with team color using a **watercolor/crayon texture**
- Slight transparency (0.6–0.8 alpha) so edges remain visible
- Optional: subtle paper grain texture overlay
- Fill should look "colored in by hand"—not perfectly uniform

#### Team Colors

| Team   | Primary Color | Fill Color (with alpha)   |
| ------ | ------------- | ------------------------- |
| RED    | `#E53935`     | `rgba(229, 57, 53, 0.5)`  |
| BLUE   | `#1E88E5`     | `rgba(30, 136, 229, 0.5)` |
| GREEN  | `#43A047`     | `rgba(67, 160, 71, 0.5)`  |
| YELLOW | `#FDD835`     | `rgba(253, 216, 53, 0.5)` |

#### Background

- Off-white/cream paper texture (`#F5F5DC` or similar)
- Optional: subtle grid paper lines in very light gray

---

### 10.2 Canvas Architecture

Two canvases are used:

1. **Main Canvas** (full viewport)
   - Renders the zoomed/panned view of the game
   - Handles touch/mouse interaction
   - Uses `transform` for pan/zoom (not re-rendering at different scales)

2. **World View Canvas** (minimap)
   - Fixed size: 150×150px (scales to fit 1000×1000 logical)
   - Positioned: bottom-right corner, 16px margin
   - Shows entire board at 1 pixel = 1 box
   - Viewport indicator: rectangle showing current view bounds
   - Semi-transparent background with border
   - Clickable: tap to jump to that location

---

### 10.3 Pan and Zoom

#### Zoom Levels

- **Min zoom**: 0.1x (entire board visible, ~1000px logical = 100px screen)
- **Max zoom**: 10x (individual boxes are ~100px)
- **Default zoom**: fit board to viewport with padding

#### Zoom Controls

- **Pinch-to-zoom** on touch devices
- **Scroll wheel** on desktop (with Ctrl/Cmd for finer control)
- **Zoom buttons** (+/−) in UI for accessibility
- **Double-tap/click** to zoom in centered on point

#### Pan Controls

- **Drag** to pan (touch or mouse)
- **Two-finger drag** on touch (after pinch gesture ends)
- **Arrow keys** for keyboard navigation
- **Momentum/inertia** for smooth panning

#### Implementation

```typescript
interface ViewState {
  // Center of the viewport in world coordinates
  centerX: number // 0..1000
  centerY: number // 0..1000

  // Zoom level (1 = 1 world unit = 1 screen pixel at base)
  zoom: number // 0.1..10
}

// Transform world coords to screen coords
function worldToScreen(
  wx: number,
  wy: number,
  view: ViewState,
  canvas: HTMLCanvasElement
) {
  const cx = canvas.width / 2
  const cy = canvas.height / 2
  return {
    x: cx + (wx - view.centerX) * view.zoom,
    y: cy + (wy - view.centerY) * view.zoom,
  }
}
```

---

### 10.4 Mobile-First Design

The game must be fully playable on mobile devices (phones and tablets).

#### Touch Interactions

- **Tap edge**: place a line (if within quota)
- **Tap and hold**: show edge preview with tooltip
- **Pinch**: zoom in/out
- **Drag**: pan the view
- **Tap minimap**: jump to location

#### Responsive Layout

```
┌──────────────────────────────────┐
│  [Team Badge]    [Score Board]   │  ← Header (fixed, 48px)
├──────────────────────────────────┤
│                                  │
│                                  │
│         Main Canvas              │  ← Fills remaining space
│         (game board)             │
│                                  │
│                         ┌──────┐ │
│                         │ Mini │ │  ← World view (150×150)
│                         │ map  │ │
│                         └──────┘ │
├──────────────────────────────────┤
│  [Quota Meter]      [Zoom +/-]   │  ← Footer (fixed, 56px)
└──────────────────────────────────┘
```

#### Breakpoints

- **Mobile** (<640px): Stack score/quota vertically, larger touch targets
- **Tablet** (640–1024px): Side-by-side layout, medium touch targets
- **Desktop** (>1024px): Full layout, hover states enabled

#### Touch Target Sizes

- Minimum 44×44px for all interactive elements
- Edges have enlarged hit areas (±8px from center line)
- Minimap has 48px minimum dimension

#### Viewport Meta

```html
<meta
  name="viewport"
  content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no"
/>
```

Disable browser zoom to prevent conflicts with canvas pinch-zoom.

---

### 10.5 World View (Minimap)

The minimap provides global context and quick navigation.

#### Rendering

- Canvas size: 150×150 CSS pixels (300×300 for Retina)
- Each box = 0.15 CSS pixels (accumulated via `ImageData`)
- Background: dark semi-transparent (`rgba(0,0,0,0.7)`)
- Border: 2px white/light gray
- Border radius: 8px

#### Content

- Unclaimed boxes: transparent (shows background)
- Claimed boxes: team color (full opacity for visibility)
- Viewport rectangle: white outline, 2px stroke

#### Interaction

- **Click/tap**: Center main view on clicked location
- **Drag**: Pan main view in real-time (optional, may be too fiddly on mobile)

#### Viewport Rectangle

```typescript
function drawViewportRect(
  ctx: CanvasRenderingContext2D,
  view: ViewState,
  canvas: HTMLCanvasElement
) {
  const scale = 150 / 1000 // minimap scale

  // Calculate visible bounds in world coords
  const halfW = canvas.width / view.zoom / 2
  const halfH = canvas.height / view.zoom / 2

  const left = (view.centerX - halfW) * scale
  const top = (view.centerY - halfH) * scale
  const width = halfW * 2 * scale
  const height = halfH * 2 * scale

  ctx.strokeStyle = "white"
  ctx.lineWidth = 2
  ctx.strokeRect(left, top, width, height)
}
```

---

### 10.6 Live Updates and Animation

As events stream in:

1. **Update derived state** (bitset, boxOwner, scores)
2. **Mark dirty regions** for incremental canvas updates
3. **Animate new claims**:
   - Flash effect: brief white overlay that fades
   - Or: box "fills in" from center outward over 200ms

#### Performance Considerations

- Use `requestAnimationFrame` for all rendering
- Batch multiple events before re-render (e.g., max 60fps)
- Only redraw visible region + dirty boxes
- Use `ImageData` for bulk pixel operations on minimap
- Consider WebGL for very high event rates (future optimization)

---

## 11) Game Lifecycle

### 11.1 Single Game Per Deployment

There is **one game per deployment**. The stream path (`/game`) is hardcoded.

To start a new game:

1. Deploy a new version with a different stream name, OR
2. Delete/reset the existing Durable Stream

The game state is entirely derived from the stream—there is no separate "game metadata" or status field.

### 11.2 Game Completion

The game is considered **complete** when all 2,002,000 edges have been placed.

Client-side detection:

```typescript
const isComplete = edgesPlacedCount === EDGE_COUNT // 2,002,000
```

When complete:

- Display final scores and winner
- Disable edge placement UI
- Show "Game Over" state

The server does not need to track completion—the DO can optionally reject draws once `edgesPlacedCount == EDGE_COUNT`, but this is just an optimization (the client would already have all edges marked as taken).

### 11.3 Share Links

Share URL:

- `https://yourdomain.com/` – the game

Since there's only one game, the URL is simple. Future versions could add `?atRecord=N` for replay scrubbing.

---

## 12) Operational Notes

### 12.1 Single DO limits (v1)

A single writer DO serializes all accepted edges. This is fine for launch but is your main scaling bottleneck if truly viral. (Sharding is a v2 path.)

### 12.2 Abuse controls (minimal)

- Signed team cookie
- Cloudflare rate limiting
- Optional: basic bot gate (Turnstile) on draw endpoint if needed

---

## 13) Application Structure

### 13.1 Project Structure

```
src/
├── app.tsx                  # App shell + providers
├── main.tsx                 # Vite entrypoint
├── components/
│   ├── game/
│   │   ├── GameCanvas.tsx      # Main game canvas with pan/zoom
│   │   ├── WorldView.tsx       # Minimap in bottom corner
│   │   ├── EdgeRenderer.ts     # Hand-drawn edge rendering logic
│   │   └── BoxRenderer.ts      # Watercolor box fill rendering
│   ├── ui/
│   │   ├── QuotaMeter.tsx      # Line quota progress bar
│   │   ├── TeamBadge.tsx       # Team color indicator
│   │   ├── ScoreBoard.tsx      # Live team scores
│   │   ├── ZoomControls.tsx    # +/- buttons
│   │   └── ShareDialog.tsx     # Share link modal (Base UI Dialog)
│   └── layout/
│       ├── Header.tsx          # Top bar with team/scores
│       └── Footer.tsx          # Bottom bar with quota/controls
├── contexts/
│   ├── game-state-context.tsx  # Game state + stream integration
│   ├── quota-context.tsx       # Quota sync + local storage
│   └── team-context.tsx        # Team assignment + identity
├── hooks/
│   ├── useGameState.ts         # GameState accessor hook
│   ├── useViewState.ts         # Pan/zoom state management
│   ├── usePanZoom.ts           # Touch/mouse pan-zoom gestures
│   └── useGameStream.ts        # Durable Streams long-poll
├── lib/
│   ├── edge-math.ts            # Edge ID ↔ (x,y) conversions
│   ├── game-state.ts           # Fold algorithm, state derivation
│   ├── hand-drawn.ts           # Wobble/bezier curve generation
│   └── stream-parser.ts        # 3-byte event parsing
└── styles/
    ├── global.css              # Reset, CSS variables, fonts
    ├── game.css                # Canvas container, layout
    └── mobile.css              # Responsive overrides
```

### 13.3 CSS Architecture

Plain CSS with CSS custom properties for theming:

```css
/* src/styles/global.css */

:root {
  /* Team colors */
  --color-red: #e53935;
  --color-blue: #1e88e5;
  --color-green: #43a047;
  --color-yellow: #fdd835;

  /* UI colors */
  --color-bg: #f5f5dc; /* Paper/cream */
  --color-text: #2d2d2d;
  --color-border: #8b8b7a;

  /* Quota colors */
  --quota-full: #43a047;
  --quota-mid: #ffc107;
  --quota-low: #e53935;

  /* Spacing */
  --header-height: 48px;
  --footer-height: 56px;
  --minimap-size: 150px;
  --minimap-margin: 16px;

  /* Touch targets */
  --touch-min: 44px;
}

/* Paper texture background */
body {
  background-color: var(--color-bg);
  background-image: url("/textures/paper-grain.png");
  font-family: "Comic Sans MS", "Chalkboard", cursive, sans-serif;
}
```

### 13.4 Base UI Component Usage

```tsx
// ShareDialog.tsx - using Base UI Dialog

import * as Dialog from "@base-ui/react/dialog"

export function ShareDialog({ gameId, open, onClose }) {
  const shareUrl = `${window.location.origin}/g/${gameId}`

  return (
    <Dialog.Root open={open} onOpenChange={onClose}>
      <Dialog.Portal>
        <Dialog.Backdrop className="dialog-backdrop" />
        <Dialog.Popup className="dialog-popup">
          <Dialog.Title>Share this game</Dialog.Title>
          <Dialog.Description>
            Copy the link to invite others to play
          </Dialog.Description>
          <input
            type="text"
            value={shareUrl}
            readOnly
            className="share-input"
          />
          <button onClick={() => navigator.clipboard.writeText(shareUrl)}>
            Copy Link
          </button>
          <Dialog.Close className="dialog-close">×</Dialog.Close>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
```

```tsx
// QuotaMeter.tsx - using Base UI Progress

import * as Progress from "@base-ui/react/progress"

export function QuotaMeter({ remaining, max, refillIn }) {
  const percent = (remaining / max) * 100
  const color = remaining > 5 ? "full" : remaining > 2 ? "mid" : "low"

  return (
    <div className="quota-meter">
      <Progress.Root value={remaining} max={max} className="quota-progress">
        <Progress.Track className="quota-track">
          <Progress.Indicator className={`quota-indicator quota-${color}`} />
        </Progress.Track>
      </Progress.Root>
      <span className="quota-text">
        {remaining}/{max} lines
      </span>
      {remaining < max && (
        <span className="quota-refill">+1 in {refillIn}s</span>
      )}
    </div>
  )
}
```

---

## 14) Testing

### 14.1 Test Stack

- **Unit tests**: Vitest
- **Component tests**: Vitest + React Testing Library
- **E2E tests**: Playwright
- **Visual regression**: Playwright screenshots (optional)

### 14.2 Project Test Structure

```
src/
├── lib/
│   ├── edge-math.ts
│   ├── edge-math.test.ts         # Unit tests
│   ├── game-state.ts
│   ├── game-state.test.ts        # Unit tests
│   ├── quota-storage.ts
│   └── quota-storage.test.ts     # Unit tests
├── hooks/
│   ├── useQuota.ts
│   └── useQuota.test.ts          # Hook tests
├── components/
│   └── ui/
│       ├── QuotaMeter.tsx
│       └── QuotaMeter.test.tsx   # Component tests
tests/
├── e2e/
│   ├── game-flow.spec.ts         # Full game E2E
│   ├── mobile.spec.ts            # Mobile interactions
│   └── quota.spec.ts             # Quota enforcement
└── integration/
    ├── do-validation.test.ts     # DO edge validation
    └── stream-replay.test.ts     # Stream state derivation
```

### 14.3 Unit Tests

#### Edge Math (`edge-math.test.ts`)

```typescript
import { describe, it, expect } from "vitest"
import {
  edgeIdToCoords,
  coordsToEdgeId,
  isHorizontal,
  getAdjacentBoxes,
  HORIZ_COUNT,
  EDGE_COUNT,
} from "./edge-math"

describe("edge-math", () => {
  describe("edgeIdToCoords", () => {
    it("converts horizontal edge at origin", () => {
      expect(edgeIdToCoords(0)).toEqual({ x: 0, y: 0, horizontal: true })
    })

    it("converts last horizontal edge", () => {
      expect(edgeIdToCoords(HORIZ_COUNT - 1)).toEqual({
        x: 999,
        y: 1000,
        horizontal: true,
      })
    })

    it("converts first vertical edge", () => {
      expect(edgeIdToCoords(HORIZ_COUNT)).toEqual({
        x: 0,
        y: 0,
        horizontal: false,
      })
    })

    it("round-trips all edge IDs", () => {
      // Test a sample of edges
      const samples = [
        0,
        1,
        999,
        1000,
        HORIZ_COUNT,
        HORIZ_COUNT + 1,
        EDGE_COUNT - 1,
      ]
      for (const id of samples) {
        const coords = edgeIdToCoords(id)
        const backToId = coordsToEdgeId(coords.x, coords.y, coords.horizontal)
        expect(backToId).toBe(id)
      }
    })
  })

  describe("getAdjacentBoxes", () => {
    it("returns two boxes for interior horizontal edge", () => {
      const boxes = getAdjacentBoxes(500 * 1000 + 500) // h(500, 500)
      expect(boxes).toHaveLength(2)
      expect(boxes).toContainEqual({ x: 500, y: 499 })
      expect(boxes).toContainEqual({ x: 500, y: 500 })
    })

    it("returns one box for top boundary horizontal edge", () => {
      const boxes = getAdjacentBoxes(0) // h(0, 0) - top edge of board
      expect(boxes).toHaveLength(1)
      expect(boxes[0]).toEqual({ x: 0, y: 0 })
    })

    it("returns one box for bottom boundary horizontal edge", () => {
      const boxes = getAdjacentBoxes(1000 * 1000) // h(0, 1000) - bottom edge
      expect(boxes).toHaveLength(1)
      expect(boxes[0]).toEqual({ x: 0, y: 999 })
    })
  })
})
```

#### Game State (`game-state.test.ts`)

```typescript
import { describe, it, expect, beforeEach } from "vitest"
import { GameState } from "./game-state"

describe("GameState", () => {
  let state: GameState

  beforeEach(() => {
    state = new GameState()
  })

  describe("applyEvent", () => {
    it("marks edge as taken", () => {
      state.applyEvent({ edgeId: 0, teamId: 0 })
      expect(state.isEdgeTaken(0)).toBe(true)
    })

    it("ignores duplicate edge", () => {
      state.applyEvent({ edgeId: 0, teamId: 0 })
      state.applyEvent({ edgeId: 0, teamId: 1 }) // Should be ignored
      expect(state.getEdgesPlacedCount()).toBe(1)
    })

    it("claims box when fourth edge is placed", () => {
      // Box at (0,0) needs edges: h(0,0), h(0,1), v(0,0), v(1,0)
      const topEdge = 0 // h(0,0)
      const bottomEdge = 1000 // h(0,1)
      const leftEdge = 1001000 // v(0,0) = HORIZ_COUNT + 0
      const rightEdge = 1001001 // v(1,0) = HORIZ_COUNT + 1

      state.applyEvent({ edgeId: topEdge, teamId: 0 })
      state.applyEvent({ edgeId: bottomEdge, teamId: 1 })
      state.applyEvent({ edgeId: leftEdge, teamId: 2 })

      expect(state.getBoxOwner(0)).toBe(0) // Unclaimed

      state.applyEvent({ edgeId: rightEdge, teamId: 3 })

      expect(state.getBoxOwner(0)).toBe(4) // Team 3 (teamId + 1)
      expect(state.getScore(3)).toBe(1)
    })
  })

  describe("scores", () => {
    it("starts with all zeros", () => {
      expect(state.getScores()).toEqual([0, 0, 0, 0])
    })

    it("increments correct team score on claim", () => {
      // Complete a box with team 2 placing final edge
      completeBox(state, 0, 0, 2)
      expect(state.getScore(2)).toBe(1)
    })
  })

  describe("serialization", () => {
    it("exports and imports state correctly", () => {
      state.applyEvent({ edgeId: 0, teamId: 0 })
      state.applyEvent({ edgeId: 1, teamId: 1 })

      const exported = state.export()
      const newState = GameState.import(exported)

      expect(newState.isEdgeTaken(0)).toBe(true)
      expect(newState.isEdgeTaken(1)).toBe(true)
      expect(newState.isEdgeTaken(2)).toBe(false)
    })
  })
})

// Helper to complete a box
function completeBox(
  state: GameState,
  x: number,
  y: number,
  finalTeam: number
) {
  const edges = getBoxEdges(x, y)
  edges
    .slice(0, 3)
    .forEach((e, i) => state.applyEvent({ edgeId: e, teamId: i }))
  state.applyEvent({ edgeId: edges[3], teamId: finalTeam })
}
```

#### Quota Storage (`quota-storage.test.ts`)

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { QuotaManager, QUOTA_KEY } from "./quota-storage"

describe("QuotaManager", () => {
  beforeEach(() => {
    localStorage.clear()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("initializes with full quota when no stored state", () => {
    const manager = new QuotaManager()
    expect(manager.getRemaining()).toBe(8)
  })

  it("restores state from localStorage", () => {
    localStorage.setItem(
      QUOTA_KEY,
      JSON.stringify({
        remaining: 5,
        lastRefillAt: Date.now(),
        version: 1,
      })
    )

    const manager = new QuotaManager()
    expect(manager.getRemaining()).toBe(5)
  })

  it("refills quota based on elapsed time", () => {
    const now = Date.now()
    localStorage.setItem(
      QUOTA_KEY,
      JSON.stringify({
        remaining: 3,
        lastRefillAt: now - 15000, // 15 seconds ago = 2 refills
        version: 1,
      })
    )

    const manager = new QuotaManager()
    expect(manager.getRemaining()).toBe(5) // 3 + 2
  })

  it("caps refill at max quota", () => {
    const now = Date.now()
    localStorage.setItem(
      QUOTA_KEY,
      JSON.stringify({
        remaining: 7,
        lastRefillAt: now - 60000, // 60 seconds ago = 8 refills
        version: 1,
      })
    )

    const manager = new QuotaManager()
    expect(manager.getRemaining()).toBe(8) // Capped at max
  })

  it("decrements quota on consume", () => {
    const manager = new QuotaManager()
    expect(manager.consume()).toBe(true)
    expect(manager.getRemaining()).toBe(7)
  })

  it("returns false when consuming with zero quota", () => {
    localStorage.setItem(
      QUOTA_KEY,
      JSON.stringify({
        remaining: 0,
        lastRefillAt: Date.now(),
        version: 1,
      })
    )

    const manager = new QuotaManager()
    expect(manager.consume()).toBe(false)
    expect(manager.getRemaining()).toBe(0)
  })

  it("refunds quota correctly", () => {
    const manager = new QuotaManager()
    manager.consume()
    manager.refund()
    expect(manager.getRemaining()).toBe(8)
  })

  it("persists changes to localStorage", () => {
    const manager = new QuotaManager()
    manager.consume()

    const stored = JSON.parse(localStorage.getItem(QUOTA_KEY)!)
    expect(stored.remaining).toBe(7)
  })
})
```

### 14.4 Component Tests

#### QuotaMeter (`QuotaMeter.test.tsx`)

```typescript
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QuotaMeter } from './QuotaMeter';

describe('QuotaMeter', () => {
  it('displays remaining quota', () => {
    render(<QuotaMeter remaining={6} max={8} refillIn={5} />);
    expect(screen.getByText('6/8 lines')).toBeInTheDocument();
  });

  it('shows refill timer when not full', () => {
    render(<QuotaMeter remaining={5} max={8} refillIn={3} />);
    expect(screen.getByText('+1 in 3s')).toBeInTheDocument();
  });

  it('hides refill timer when full', () => {
    render(<QuotaMeter remaining={8} max={8} refillIn={0} />);
    expect(screen.queryByText(/\+1 in/)).not.toBeInTheDocument();
  });

  it('applies low color class when quota is low', () => {
    const { container } = render(<QuotaMeter remaining={1} max={8} refillIn={5} />);
    expect(container.querySelector('.quota-low')).toBeInTheDocument();
  });

  it('applies full color class when quota is high', () => {
    const { container } = render(<QuotaMeter remaining={7} max={8} refillIn={5} />);
    expect(container.querySelector('.quota-full')).toBeInTheDocument();
  });
});
```

### 14.5 Integration Tests

#### DO Validation (`do-validation.test.ts`)

Tests the GameWriterDO logic (run against local Wrangler):

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { unstable_dev } from "wrangler"
import type { UnstableDevWorker } from "wrangler"

describe("GameWriterDO", () => {
  let worker: UnstableDevWorker

  beforeAll(async () => {
    worker = await unstable_dev("src/worker.ts", {
      experimental: { disableExperimentalWarning: true },
    })
  })

  afterAll(async () => {
    await worker.stop()
  })

  it("accepts valid edge placement", async () => {
    const res = await worker.fetch("/draw", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: "boxes_team=0.validSignature",
      },
      body: JSON.stringify({ edgeId: 12345 }),
    })

    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.ok).toBe(true)
  })

  it("rejects duplicate edge placement", async () => {
    // Place edge first time
    await worker.fetch("/draw", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: "boxes_team=0.validSignature",
      },
      body: JSON.stringify({ edgeId: 99999 }),
    })

    // Try to place same edge again
    const res = await worker.fetch("/draw", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: "boxes_team=1.validSignature",
      },
      body: JSON.stringify({ edgeId: 99999 }),
    })

    expect(res.status).toBe(409)
    const data = await res.json()
    expect(data.code).toBe("EDGE_TAKEN")
  })

  it("rejects invalid edge ID", async () => {
    const res = await worker.fetch("/draw", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: "boxes_team=0.validSignature",
      },
      body: JSON.stringify({ edgeId: 9999999 }), // Out of range
    })

    expect(res.status).toBe(400)
  })

  it("rejects request without team cookie", async () => {
    const res = await worker.fetch("/draw", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ edgeId: 11111 }),
    })

    expect(res.status).toBe(401)
  })
})
```

#### Stream Replay (`stream-replay.test.ts`)

```typescript
import { describe, it, expect } from "vitest"
import { GameState } from "../lib/game-state"
import { parseStreamRecords } from "../lib/stream-parser"

describe("Stream Replay", () => {
  it("replays empty stream to empty state", () => {
    const state = new GameState()
    const records = parseStreamRecords(new Uint8Array(0))

    records.forEach((r) => state.applyEvent(r))

    expect(state.getEdgesPlacedCount()).toBe(0)
    expect(state.getScores()).toEqual([0, 0, 0, 0])
  })

  it("replays single record correctly", () => {
    const state = new GameState()
    // edgeId=100, teamId=2 => (100 << 2) | 2 = 402 = 0x000192
    const bytes = new Uint8Array([0x00, 0x01, 0x92])
    const records = parseStreamRecords(bytes)

    expect(records).toHaveLength(1)
    expect(records[0]).toEqual({ edgeId: 100, teamId: 2 })

    records.forEach((r) => state.applyEvent(r))
    expect(state.isEdgeTaken(100)).toBe(true)
  })

  it("handles partial record at end gracefully", () => {
    // 4 bytes = 1 complete record + 1 partial byte
    const bytes = new Uint8Array([0x00, 0x01, 0x92, 0xff])
    const records = parseStreamRecords(bytes)

    expect(records).toHaveLength(1) // Only complete records
  })

  it("replays 1000 records and computes correct scores", () => {
    const state = new GameState()
    const bytes = generateTestStream(1000)
    const records = parseStreamRecords(bytes)

    records.forEach((r) => state.applyEvent(r))

    expect(state.getEdgesPlacedCount()).toBe(1000)
    // Scores should sum to number of completed boxes
    const totalBoxes = state.getScores().reduce((a, b) => a + b, 0)
    expect(totalBoxes).toBeGreaterThanOrEqual(0)
  })
})

function generateTestStream(count: number): Uint8Array {
  const bytes = new Uint8Array(count * 3)
  for (let i = 0; i < count; i++) {
    const edgeId = i // Sequential edges
    const teamId = i % 4
    const packed = (edgeId << 2) | teamId
    bytes[i * 3] = (packed >> 16) & 0xff
    bytes[i * 3 + 1] = (packed >> 8) & 0xff
    bytes[i * 3 + 2] = packed & 0xff
  }
  return bytes
}
```

### 14.6 E2E Tests (Playwright)

#### Game Flow (`game-flow.spec.ts`)

```typescript
import { test, expect } from "@playwright/test"

test.describe("Game Flow", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
  })

  test("displays team badge on load", async ({ page }) => {
    await expect(page.locator('[data-testid="team-badge"]')).toBeVisible()
    await expect(page.locator('[data-testid="team-badge"]')).toHaveText(
      /RED|BLUE|GREEN|YELLOW/
    )
  })

  test("displays quota meter", async ({ page }) => {
    await expect(page.locator('[data-testid="quota-meter"]')).toBeVisible()
    await expect(page.locator('[data-testid="quota-meter"]')).toContainText(
      "/8 lines"
    )
  })

  test("displays scoreboard with four teams", async ({ page }) => {
    await expect(page.locator('[data-testid="scoreboard"]')).toBeVisible()
    await expect(page.locator('[data-testid="score-red"]')).toBeVisible()
    await expect(page.locator('[data-testid="score-blue"]')).toBeVisible()
    await expect(page.locator('[data-testid="score-green"]')).toBeVisible()
    await expect(page.locator('[data-testid="score-yellow"]')).toBeVisible()
  })

  test("displays world view minimap", async ({ page }) => {
    await expect(page.locator('[data-testid="world-view"]')).toBeVisible()
  })

  test("can zoom in and out", async ({ page }) => {
    const zoomIn = page.locator('[data-testid="zoom-in"]')
    const zoomOut = page.locator('[data-testid="zoom-out"]')

    await expect(zoomIn).toBeVisible()
    await expect(zoomOut).toBeVisible()

    // Click zoom in
    await zoomIn.click()
    // Verify zoom level changed (check canvas transform or data attribute)

    // Click zoom out
    await zoomOut.click()
  })

  test("shows edge highlight on hover", async ({ page }) => {
    // Zoom in first to make edges visible
    await page.locator('[data-testid="zoom-in"]').click()
    await page.locator('[data-testid="zoom-in"]').click()

    // Hover over canvas center
    const canvas = page.locator('[data-testid="game-canvas"]')
    await canvas.hover({ position: { x: 300, y: 300 } })

    // Check for hover state (implementation-specific)
  })

  test("decrements quota on edge click", async ({ page }) => {
    // Get initial quota
    const quotaText = await page
      .locator('[data-testid="quota-meter"]')
      .textContent()
    const initialQuota = parseInt(quotaText?.match(/(\d+)\/8/)?.[1] || "8")

    // Zoom in and click an edge
    await page.locator('[data-testid="zoom-in"]').click()
    await page.locator('[data-testid="zoom-in"]').click()

    const canvas = page.locator('[data-testid="game-canvas"]')
    await canvas.click({ position: { x: 300, y: 300 } })

    // Wait for response
    await page.waitForTimeout(500)

    // Check quota decreased (or stayed same if edge was taken)
    const newQuotaText = await page
      .locator('[data-testid="quota-meter"]')
      .textContent()
    const newQuota = parseInt(newQuotaText?.match(/(\d+)\/8/)?.[1] || "8")

    expect(newQuota).toBeLessThanOrEqual(initialQuota)
  })
})
```

#### Mobile Tests (`mobile.spec.ts`)

```typescript
import { test, expect, devices } from "@playwright/test"

test.use({ ...devices["iPhone 13"] })

test.describe("Mobile", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
  })

  test("displays mobile-optimized layout", async ({ page }) => {
    // Header and footer should be visible
    await expect(page.locator('[data-testid="header"]')).toBeVisible()
    await expect(page.locator('[data-testid="footer"]')).toBeVisible()

    // World view should be smaller on mobile
    const worldView = page.locator('[data-testid="world-view"]')
    const box = await worldView.boundingBox()
    expect(box?.width).toBeLessThanOrEqual(120) // Smaller on mobile
  })

  test("supports pinch-to-zoom", async ({ page }) => {
    const canvas = page.locator('[data-testid="game-canvas"]')

    // Simulate pinch gesture
    await canvas.dispatchEvent("touchstart", {
      touches: [
        { clientX: 100, clientY: 200, identifier: 0 },
        { clientX: 200, clientY: 200, identifier: 1 },
      ],
    })

    await canvas.dispatchEvent("touchmove", {
      touches: [
        { clientX: 50, clientY: 200, identifier: 0 },
        { clientX: 250, clientY: 200, identifier: 1 },
      ],
    })

    await canvas.dispatchEvent("touchend", {})

    // Verify zoom changed
  })

  test("supports pan with drag", async ({ page }) => {
    const canvas = page.locator('[data-testid="game-canvas"]')

    await canvas.dispatchEvent("touchstart", {
      touches: [{ clientX: 200, clientY: 300, identifier: 0 }],
    })

    await canvas.dispatchEvent("touchmove", {
      touches: [{ clientX: 250, clientY: 350, identifier: 0 }],
    })

    await canvas.dispatchEvent("touchend", {})

    // Verify pan changed
  })

  test("touch targets are at least 44px", async ({ page }) => {
    const zoomIn = page.locator('[data-testid="zoom-in"]')
    const box = await zoomIn.boundingBox()

    expect(box?.width).toBeGreaterThanOrEqual(44)
    expect(box?.height).toBeGreaterThanOrEqual(44)
  })
})
```

### 14.7 Test Commands

```json
{
  "scripts": {
    "test": "vitest",
    "test:unit": "vitest run --testPathPattern='\\.test\\.ts'",
    "test:e2e": "playwright test",
    "test:e2e:headed": "playwright test --headed",
    "test:coverage": "vitest run --coverage",
    "test:integration": "vitest run tests/integration"
  }
}
```

### 14.8 CI Configuration

```yaml
# .github/workflows/test.yml
name: Test

on: [push, pull_request]

jobs:
  unit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v2
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: "pnpm"
      - run: pnpm install
      - run: pnpm test:unit

  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v2
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: "pnpm"
      - run: pnpm install
      - run: pnpm dlx playwright install --with-deps
      - run: pnpm build
      - run: pnpm test:e2e
      - uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: playwright-report
          path: playwright-report/
```

---

## 15) Future Extensions (designed-in hooks)

- **Sharded writer DOs** by region if needed.
- **Server-derived aggregates** (tiles, scores) if client computation becomes too heavy on low-end devices.
- Individual accounts and per-user leaderboards (requires including userId in events, or a secondary claim log).
- Snapshots for instant join (not required if you're happy with full replay).
