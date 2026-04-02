# Territory Wars

Multiplayer territory game built with [Yjs](https://yjs.dev) CRDTs on [Durable Streams](https://electric-sql.com/primitives/durable-streams). Players claim cells by moving over them. Each cell is a Yjs CRDT entry — last-writer-wins resolves contention. Encircle an area to fill it. First to 20% wins, or highest territory after 2 minutes.

Built with React, TypeScript, and [Electric Cloud](https://electric-sql.com/cloud).

## Setup

1. Copy `.env.example` to `.env`:

```sh
cp .env.example .env
```

2. Fill in your environment variables:

| Variable            | Description                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------------- |
| `VITE_YJS_URL`      | Yjs service URL from Electric Cloud                                                                     |
| `VITE_YJS_TOKEN`    | Yjs service auth token                                                                                  |
| `VITE_DS_URL`       | Durable Streams service URL from Electric Cloud                                                         |
| `VITE_DS_TOKEN`     | Durable Streams service auth token                                                                      |
| `ANTHROPIC_API_KEY` | Anthropic API key for AI bot agents (get one at [console.anthropic.com](https://console.anthropic.com)) |

3. Install dependencies:

```sh
pnpm install
```

## Running

### Game client (browser)

```sh
pnpm dev
```

Opens the game UI at `http://localhost:3002`.

### AI Agent Server

In a separate terminal:

```sh
pnpm dev:server
```

The agent server watches the room registry stream for new rooms and automatically spawns **4 AI bot players** into each one. Each bot uses Claude Haiku to decide strategy every 3 seconds and moves using greedy pathfinding between API calls. Bots can only move to adjacent cells (up/down/left/right), one step at a time.

### Playing

1. Start the game client (`pnpm dev`)
2. Start the AI agent server (`pnpm dev:server`)
3. Open `http://localhost:3002` in your browser
4. Choose a board size (32x32, 64x64, or 128x128) and create a room
5. 4 AI bots will automatically join
6. Compete! Claim 20% territory or have the most when the 2-minute timer runs out

## How it works

- **Board sizes** — 32x32, 64x64 (default), or 128x128. AI agents adapt their strategy to the board dimensions.
- **Cells** are stored in a [Yjs Y.Map](https://docs.yjs.dev/api/shared-types/y.map) — each key is a grid coordinate, each value records the owner. When two players claim the same cell, Yjs LWW resolves the conflict.
- **Territory fill** — when your cells form a closed boundary around empty space, the enclosed area is automatically claimed.
- **AI agents** — the server subscribes to the room registry Durable Stream. When a new room appears, it spawns 4 bots that each connect as a Yjs client. Every 3 seconds, each bot sends a board summary to Claude Haiku which returns a strategic target. Between calls, the bot moves one adjacent cell at a time toward the target using greedy pathfinding.
- **Movement validation** — all moves (human and bot) go through a shared `executeMove()` function that enforces adjacent-only movement, collision detection, stun, and enclosure fill.
- **Game timer** — 2 minutes per round. First to 20% wins immediately; otherwise highest territory % when time runs out.
- **Room registry** and **presence** use Durable Streams. The agent server watches the raw stream for insert/delete events to manage bot lifecycle.
- **No WebSockets** — all sync happens over plain HTTP.

## Controls

- **Keyboard**: arrow keys or WASD
- **Mouse**: click on the board to move toward the click
- **Touch**: tap or swipe on the board

## License

MIT
