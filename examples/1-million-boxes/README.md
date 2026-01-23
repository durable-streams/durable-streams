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
- Syncs across browser tabs

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
│                     Cloudflare Edge                                 │
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
- **Optimistic Updates**: Edges appear immediately, confirmed via SSE

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
