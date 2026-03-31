# Territory Wars

Multiplayer territory game built with [Yjs](https://yjs.dev) CRDTs on [Durable Streams](https://electric-sql.com/primitives/durable-streams). Players claim cells by moving over them. Each cell is a Yjs CRDT entry — last-writer-wins resolves contention. Encircle an area to fill it. First to 20% wins, or highest territory after 2 minutes.

Built with React, TypeScript, and [Electric Cloud](https://electric-sql.com/cloud).

## Prerequisites

This project depends on the `@durable-streams` packages. Clone the [durable-streams](https://github.com/durable-streams/durable-streams) repo as a sibling directory:

```
parent/
├── durable-streams/   # git clone https://github.com/durable-streams/durable-streams
└── territory-wars/    # this repo
```

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
npm install
```

## Running

### Game client (browser)

```sh
npm run dev
```

Opens the game UI at `http://localhost:3002`.

### AI Agent Server

In a separate terminal:

```sh
npm run dev:server
```

The agent server watches for new rooms and automatically spawns **10 AI bot players** into each room. Each bot uses Claude Haiku to decide strategy every 3 seconds and moves using greedy pathfinding between API calls.

Bot names: Bot-Alpha, Bot-Bravo, Bot-Charlie, Bot-Delta, Bot-Echo, Bot-Foxtrot, Bot-Golf, Bot-Hotel, Bot-India, Bot-Juliet.

### Playing

1. Start the game client (`npm run dev`)
2. Start the AI agent server (`npm run dev:server`)
3. Open `http://localhost:3002` in your browser
4. Create a room — 10 AI bots will automatically join
5. Compete! Claim 20% territory or have the most when time runs out

## How it works

- **512x512 board** — 262,144 cells on a large grid
- **Cells** are stored in a [Yjs Y.Map](https://docs.yjs.dev/api/shared-types/y.map) — each key is a grid coordinate, each value records the owner. When two players claim the same cell, Yjs LWW resolves the conflict.
- **Territory fill** — when your cells form a closed boundary around empty space, the enclosed area is automatically claimed.
- **AI agents** — each bot connects as a real Yjs client. Every 3 seconds it sends a board summary to Claude Haiku which returns a strategic target. Between calls, the bot moves toward the target using greedy pathfinding.
- **Game timer** — 2 minutes per round. First to 20% wins immediately; otherwise highest territory % when time runs out.
- **Room registry** and **presence** use [StreamDB](https://electric-sql.com/docs/api/durable-streams/stream-db) on Durable Streams.
- **No WebSockets** — all sync happens over plain HTTP via the [Yjs Durable Streams Protocol](https://github.com/durable-streams/durable-streams/blob/main/packages/y-durable-streams/YJS-PROTOCOL.md).

## Controls

- **Keyboard**: arrow keys or WASD
- **Mouse**: click on the board to move toward the click
- **Touch**: tap or swipe on the board

## License

MIT
