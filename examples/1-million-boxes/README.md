# 1 Million Boxes

A global, real-time multiplayer game of Dots & Boxes on a **1000×1000 grid** (1,000,000 boxes). Four teams (**Red**, **Blue**, **Green**, **Yellow**) compete to claim the most boxes by placing edges on the grid.

## How It Works

- Players place **edges** (lines) on the grid
- When a player places the **4th edge** completing a box, their team claims it
- The game uses **Durable Streams** for real-time synchronization
- All game state is derived from an append-only log of edge placements
- Each edge placement is just **3 bytes** (edge ID + team ID)

## Technology Stack

| Layer         | Technology                     |
| ------------- | ------------------------------ |
| Frontend      | React 19 + Vite + TypeScript   |
| Backend       | Hono (Cloudflare Workers)      |
| UI Components | [Base UI](https://base-ui.com) |
| Styling       | Plain CSS                      |
| Runtime       | Cloudflare Workers             |
| State         | Cloudflare Durable Objects     |
| Real-time     | Durable Streams (SSE)          |
| Rendering     | HTML Canvas (2D)               |

## Prerequisites

- Node.js 20+
- pnpm 8+
- A running Durable Streams server (from this repo)

## Getting Started

### 1. Install Dependencies

From the repository root:

```bash
pnpm install
```

Or from this directory:

```bash
cd examples/1-million-boxes
pnpm install
```

### 2. Start the Durable Streams Server

In a separate terminal, start the local Durable Streams development server:

```bash
# From the repository root
cd packages/server
pnpm dev
```

This starts the stream server on `http://localhost:4437`. The stream endpoint will be at `http://localhost:4437/v1/stream/game`.

### 3. Configure Environment Variables

Create a `.dev.vars` file in this directory:

```bash
DURABLE_STREAMS_URL=http://localhost:4437/v1/stream
TEAM_COOKIE_SECRET=dev-secret-change-in-production
```

### 4. Start the Development Server

```bash
pnpm dev
```

The app will be available at `http://localhost:5173`.

## Available Scripts

| Script               | Description                      |
| -------------------- | -------------------------------- |
| `pnpm dev`           | Start development server         |
| `pnpm build`         | Build for production             |
| `pnpm preview`       | Preview production build locally |
| `pnpm deploy`        | Deploy to Cloudflare Workers     |
| `pnpm test`          | Run unit tests                   |
| `pnpm test:unit`     | Run unit tests once              |
| `pnpm test:watch`    | Run tests in watch mode          |
| `pnpm test:coverage` | Run tests with coverage          |
| `pnpm test:e2e`      | Run Playwright E2E tests         |
| `pnpm cf-typegen`    | Generate Cloudflare types        |

## Project Structure

```
src/                    # React SPA
├── app.tsx             # Main app with providers
├── main.tsx            # Entry point
├── components/
│   ├── game/           # GameCanvas, WorldView, renderers
│   ├── layout/         # Header, Footer
│   └── ui/             # QuotaMeter, TeamBadge, ScoreBoard, etc.
├── contexts/           # React contexts (Team, Quota, GameState)
├── hooks/              # Custom hooks (useViewState, usePanZoom, etc.)
├── lib/                # Core logic (edge-math, game-state, stream-parser)
└── styles/             # CSS files

worker/                 # Hono API backend
├── index.ts            # Hono app entry point
├── routes/
│   ├── stream.ts       # Stream proxy routes
│   ├── team.ts         # Team assignment
│   └── draw.ts         # Draw edge endpoint
├── do/
│   └── game-writer.ts  # GameWriterDO (Durable Object)
└── lib/                # Shared utilities

tests/
├── e2e/                # Playwright E2E tests
└── integration/        # Integration tests
```

## Game Features

### Controls

- **Click/Tap** on an edge to place it (when zoomed in)
- **Drag** to pan around the board
- **Scroll wheel** or **pinch** to zoom in/out
- **Double-tap** to zoom in (mobile)
- **Click minimap** to jump to a location

### Quota System

- Each player has **8 lines** they can place
- Lines refill at **1 line per 7.5 seconds**
- Quota persists across page refreshes (localStorage)
- Syncs across browser tabs in real-time

#### Cross-Tab Quota Sync

The quota system uses the browser's `storage` event to sync state across tabs without any server communication:

```typescript
// Quota state stored in localStorage
interface QuotaState {
  remaining: number // Current tokens available
  lastRefillAt: number // Timestamp of last refill
}

// Listen for changes from other tabs
useEffect(() => {
  const handler = (e: StorageEvent) => {
    if (e.key === QUOTA_KEY && e.newValue) {
      setState(JSON.parse(e.newValue))
    }
  }
  window.addEventListener("storage", handler)
  return () => window.removeEventListener("storage", handler)
}, [])
```

**How it works:**

1. **Tab A** consumes a token → updates React state → saves to localStorage
2. **Browser** fires `storage` event to all other same-origin tabs
3. **Tab B** receives event → parses new value → updates its React state
4. Both tabs now show the same quota instantly

This pattern provides real-time sync without WebSockets or BroadcastChannel, using only the built-in localStorage event system.

### Team Assignment

- Teams are assigned randomly on first visit
- Stored in a signed HTTP-only cookie
- Persists for 1 year

## Deployment

### Deploy to Cloudflare Workers

1. **Login to Cloudflare:**

```bash
pnpm dlx wrangler login
```

2. **Set production secrets:**

```bash
pnpm dlx wrangler secret put DURABLE_STREAMS_URL
# Enter your production Durable Streams URL (e.g., https://streams.electric-sql.com/v1/stream)

pnpm dlx wrangler secret put DURABLE_STREAMS_AUTH
# Enter your Electric Cloud API key (if using Electric Cloud)

pnpm dlx wrangler secret put TEAM_COOKIE_SECRET
# Enter a secure random secret for signing team cookies
```

3. **Deploy:**

```bash
pnpm deploy
```

### Production Configuration

For production, you'll need:

1. **Durable Streams Server** - Either:
   - Self-hosted using the `caddy-plugin` from this repo
   - Hosted on [ElectricSQL Cloud](https://electric-sql.com/)

2. **Environment Variables:**

   | Variable               | Required | Description                                   |
   | ---------------------- | -------- | --------------------------------------------- |
   | `DURABLE_STREAMS_URL`  | Yes      | URL to your production Durable Streams server |
   | `DURABLE_STREAMS_AUTH` | If Cloud | API key for Electric Cloud authentication     |
   | `TEAM_COOKIE_SECRET`   | Yes      | Secure random string for signing team cookies |

3. **Stream Proxy Security:**
   When using Electric Cloud or any authenticated stream server, the worker acts as a proxy:
   - Clients connect to `/api/stream/game` on the worker
   - The worker adds authentication headers and forwards to the stream server
   - Users can only read (GET/HEAD), not write (POST/PUT) - writes go through the GameWriterDO

## Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│                     Cloudflare Edge                                │
│  ┌─────────────────────────┐    ┌───────────────────────────────┐  │
│  │  Hono Worker            │    │  GameWriterDO                 │  │
│  │                         │───▶│  - edge bitset (250KB)        │  │
│  │  GET  /* → React SPA    │    │  - validates moves            │  │
│  │  GET  /api/team         │    │  - appends to stream          │  │
│  │  POST /api/draw         │    └─────────────┬─────────────────┘  │
│  │  GET  /api/stream/game  │                  │                    │
│  │       (stream proxy)    │                  │ POST               │
│  └─────────────────────────┘                  │                    │
└────────────────────────────┼──────────────────┼────────────────────┘
                             │                  │
                             │ GET/SSE          │
                             │                  ▼
                             │  ┌─────────────────────────────────────┐
                             │  │  Durable Streams Server             │
                             │  │  (ElectricSQL Cloud / Self-hosted)  │
                             │  │                                     │
                             │  │  Stream: /game                      │
                             │  │  - append-only log                  │
                             │  │  - SSE for live tail                │
                             │  └─────────────────────────────────────┘
                             │                  ▲
                             │                  │
┌────────────────────────────┼──────────────────┼─────────────────────┐
│  Browser Clients           │                  │                     │
│  - All stream requests ────┘                  │                     │
│    proxied through worker                     │                     │
│  - derive game state locally                                        │
└─────────────────────────────────────────────────────────────────────┘
```

### Key Concepts

- **Edge ID**: Each of the 2,002,000 edges has a unique ID (0 to 2,001,999)
- **Event Format**: 3 bytes per event (`edgeId << 2 | teamId`)
- **Client-side State**: Clients derive all state (box ownership, scores) from the stream
- **Optimistic Updates**: Edges appear immediately, confirmed via long-poll

## Durable Streams Integration

The game uses [Durable Streams](../../README.md) as the backbone for real-time state synchronization. All game state is derived from an append-only log of edge placement events.

### Stream Architecture

```
┌───────────────────────────────────────────────────────────────────────────┐
│  Browser                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │  React App                                                          │  │
│  │                                                                     │  │
│  │  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐  │  │
│  │  │ useGameStream   │───▶│  StreamParser   │───▶│   GameState     │  │  │
│  │  │                 │    │                 │    │                 │  │  │
│  │  │ DurableStream   │    │ Decodes 3-byte  │    │ Applies events  │  │  │
│  │  │ client library  │    │ records into    │    │ to derive:      │  │  │
│  │  │                 │    │ {edgeId,teamId} │    │ - edges placed  │  │  │
│  │  │ live: long-poll │    │                 │    │ - box ownership │  │  │
│  │  │                 │    │                 │    │ - team scores   │  │  │
│  │  └─────────────────┘    └─────────────────┘    └─────────────────┘  │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────────────┘
```

### Client-Side: Reading the Stream

The frontend uses the `@durable-streams/client` library:

```typescript
import { DurableStream } from "@durable-streams/client"

// Create stream instance
const stream = new DurableStream({ url: "/api/stream/game" })

// Stream with long-polling for live updates
const response = await stream.stream({ live: "long-poll" })

// Subscribe to binary chunks
response.subscribeBytes((chunk) => {
  const events = parser.feed(chunk.data) // Parse 3-byte records
  for (const event of events) {
    gameState.applyEvent(event) // Update local state
  }
})
```

**Why Long-Poll instead of SSE?**  
The stream uses `application/octet-stream` content type for binary data. SSE (`text/event-stream`) requires text encoding, so we use long-polling which natively supports binary chunks.

### Server-Side: Writing to the Stream

The `GameWriterDO` Durable Object handles all write operations:

1. **Initialization**: Replays the entire stream to rebuild in-memory state
2. **Validation**: Checks edge availability, team validity, game completion
3. **Append**: Posts encoded 3-byte record to Durable Streams server
4. **State Update**: Applies event to local state for future validations

```typescript
// Encode and append a move
const event = { edgeId: 12345, teamId: 2 }
const encoded = encodeEvent(event) // 3 bytes

await fetch(streamUrl, {
  method: "POST",
  headers: { "Content-Type": "application/octet-stream" },
  body: encoded,
})
```

## Wire Format: Bit-Packed Events

Each edge placement is encoded as a **3-byte (24-bit) big-endian** value for minimal bandwidth and storage.

### Packed Format

```
Byte 0        Byte 1        Byte 2
┌─────────┐   ┌─────────┐   ┌─────────┐
│ 7     0 │   │ 7     0 │   │ 7     0 │
├─────────┤   ├─────────┤   ├─────────┤
│ E E E E │   │ E E E E │   │ E E E E │
│ E E E E │   │ E E E E │   │ E E T T │
└─────────┘   └─────────┘   └─────────┘

E = Edge ID bits (22 bits total, max value ~4.2 million)
T = Team ID bits (2 bits, values 0-3)

packed = (edgeId << 2) | teamId
```

### Encoding/Decoding

```typescript
// Encode: GameEvent → 3 bytes
function encodeEvent(event: GameEvent): Uint8Array {
  const packed = (event.edgeId << 2) | event.teamId
  return new Uint8Array([
    (packed >> 16) & 0xff, // High byte
    (packed >> 8) & 0xff, // Middle byte
    packed & 0xff, // Low byte
  ])
}

// Decode: 3 bytes → GameEvent
function decodeRecord(bytes: Uint8Array, offset: number): GameEvent {
  const packed =
    (bytes[offset] << 16) | (bytes[offset + 1] << 8) | bytes[offset + 2]
  return {
    edgeId: packed >> 2,
    teamId: packed & 0b11,
  }
}
```

### Edge ID Layout

The grid has 1000×1000 boxes, requiring 2,002,000 edges:

| Edge Type  | Count     | ID Range              | Formula                    |
| ---------- | --------- | --------------------- | -------------------------- |
| Horizontal | 1,001,000 | 0 – 1,000,999         | `y * 1000 + x`             |
| Vertical   | 1,001,000 | 1,001,000 – 2,001,999 | `1,001,000 + y * 1001 + x` |

- **Horizontal edges**: 1001 rows × 1000 edges/row
- **Vertical edges**: 1000 rows × 1001 edges/row

### Bandwidth Efficiency

| Metric          | Value               |
| --------------- | ------------------- |
| Bytes per event | 3                   |
| Max stream size | ~6 MB (all edges)   |
| Initial sync    | Single HTTP request |
| Live updates    | Long-poll chunks    |

### Streaming Parser

The `StreamParser` class handles chunk boundaries correctly:

```typescript
class StreamParser {
  private buffer: Uint8Array = new Uint8Array(0)

  feed(chunk: Uint8Array): Array<GameEvent> {
    // Combine with buffered partial record
    const combined = new Uint8Array(this.buffer.length + chunk.length)
    combined.set(this.buffer)
    combined.set(chunk, this.buffer.length)

    // Parse complete 3-byte records
    const recordCount = Math.floor(combined.length / 3)
    const events = parseRecords(combined.subarray(0, recordCount * 3))

    // Buffer any remaining 1-2 bytes for next chunk
    this.buffer = combined.slice(recordCount * 3)
    return events
  }
}
```

This ensures that even if a chunk boundary falls mid-record, the parser correctly buffers and reassembles the data

## Testing

### Run All Tests

```bash
pnpm test
```

### Run E2E Tests

```bash
# Install Playwright browsers first
pnpm dlx playwright install

# Run E2E tests
pnpm test:e2e

# Run in headed mode (see browser)
pnpm test:e2e:headed
```

## License

See the repository root for license information.
