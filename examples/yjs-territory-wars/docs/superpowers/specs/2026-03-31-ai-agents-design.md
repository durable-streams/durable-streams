# AI Agents for Territory Wars

## Overview

Add a Node.js server that automatically spawns 10 AI-controlled players into every Territory Wars room. Each AI player connects via Yjs (same as browser players), calls Claude Haiku every 3 seconds for strategic targeting, and uses greedy pathfinding for move-by-move execution. Human players can join any room and compete against the bots.

## Game Rule Changes

### Board size

Default board changes from 30x25 to **512x512** (262,144 cells). The room ID encoding (`name__COLSxROWS`) stays the same.

### Win condition

First player to **20%** territory wins, OR highest territory % after **2 minutes**. The timer starts when the first player joins and is tracked in the Yjs doc as a shared timestamp (`gameStartedAt` in a `Y.Map("gameState")`).

### Rendering adjustments

- Cell size drops from 14px to 2px (SVG viewBox handles scaling)
- Grid lines are not rendered on the 512x512 board (too dense to be useful)
- SVG viewBox remains `0 0 {W} {H}`, browser scales responsively

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                   server.ts (Node.js)                │
│                                                      │
│  ┌─────────────────┐    ┌──────────────────────────┐ │
│  │  Room Watcher    │    │  AI Player Pool          │ │
│  │  (StreamDB on    │───>│  Per room: 10 instances  │ │
│  │  __snake_rooms)  │    │  of AIPlayer             │ │
│  └─────────────────┘    └──────────────────────────┘ │
│                                │                     │
│                    ┌───────────┼───────────┐         │
│                    ▼           ▼           ▼         │
│               ┌─────────┐ ┌─────────┐ ┌─────────┐   │
│               │AIPlayer │ │AIPlayer │ │AIPlayer │   │
│               │ Yjs+    │ │ Yjs+    │ │ Yjs+    │   │
│               │ Haiku+  │ │ Haiku+  │ │ Haiku+  │   │
│               │ A*      │ │ A*      │ │ A*      │   │
│               └─────────┘ └─────────┘ └─────────┘   │
└──────────────────────────────────────────────────────┘
         │                      │
         ▼                      ▼
    Durable Streams        Yjs Documents
    (room registry)       (game state per room)
```

### Room Watcher (`agent-server.ts`)

- Connects to the `__snake_rooms` Durable Stream using `createStreamDB` (same pattern as `registry-context.tsx`)
- Watches the rooms collection for changes
- When a new `roomId` appears: spawns 10 `AIPlayer` instances for that room
- When a room expires (`expiresAt < now`) or is deleted: destroys all agents for that room
- Tracks active rooms in a `Map<roomId, AIPlayer[]>` to avoid duplicate spawns
- Polls room expiry every 30 seconds

### AI Player (`ai-player.ts`)

Each AI player is a self-contained class:

```typescript
class AIPlayer {
  // Identity
  playerId: string // "bot-{name}-{random}"
  playerName: string // "Bot-Alpha", "Bot-Bravo", etc. (NATO alphabet)
  playerColor: string // From PLAYER_COLORS palette

  // Yjs connection
  doc: Y.Doc
  awareness: Awareness
  provider: YjsProvider

  // Game loop
  target: { x: number; y: number } | null
  moveInterval: NodeJS.Timer // 120ms
  strategyInterval: NodeJS.Timer // 3s
}
```

**Lifecycle:**

1. Create Yjs doc + awareness, connect via `YjsProvider`
2. Wait for `synced` event
3. Pick random start position, write to players map + claim starting cell
4. Start move loop (120ms) and strategy loop (3s)
5. On destroy: clear intervals, remove from players map, disconnect provider, destroy doc

**Start positions:** Each bot picks a random position. To spread bots out, each bot picks a random position in its assigned sector (divide the 512x512 board into a 4x3 grid of sectors, assign one per bot, with 2 bots doubling up in random sectors).

### Haiku Strategy Client (`haiku-client.ts`)

**API call:** Uses the Anthropic SDK (`@anthropic-ai/sdk`) with `claude-haiku-4-5-20251001`.

**System prompt:**

```
You are an AI player in Territory Wars, a multiplayer grid-based territory capture game.

Rules:
- You move one cell per step (up/down/left/right) on a 512x512 grid
- Every cell you move to is claimed as yours
- If you form a closed boundary around empty cells, they are auto-filled as yours
- Colliding with another player stuns both for 1.5 seconds
- First to 20% territory wins, or highest % after 2 minutes
- Cells from disconnected players become reclaimable

Strategy tips:
- Enclosing large empty areas is the fastest way to gain territory
- Avoid other players to prevent stun
- Work edges and borders to create enclosures efficiently
- Prioritize unclaimed regions over stealing from opponents

Respond with JSON only: { "target": { "x": <int>, "y": <int> }, "strategy": "<brief reason>" }
```

**User message (board summary):**

```
Position: (x, y)
Territory: N% (rank M of P players)
Time remaining: Xs

Sector map (8x8 grid, each sector is 64x64 cells):
  [sector_row, sector_col]: {unclaimed: N%, mine: N%, opponent: N%}
  ... (only sectors with >5% of any player)

Nearby players (within 100 cells):
  - "PlayerName" at (x, y), distance D, territory N%

Border analysis:
  - Nearest unclaimed region center: (x, y), ~N unclaimed cells
  - Open border segments I could close: [(x1,y1)-(x2,y2), ...]
```

**Cost control:** Each call uses ~500 input tokens and ~50 output tokens. At 10 bots x 1 call/3s = ~3.3 calls/second per room. With Haiku pricing this is negligible.

**Error handling:** If Haiku returns invalid JSON or errors, the bot continues toward its last target. If no target exists, it picks a random unclaimed cell.

### Pathfinder (`pathfinder.ts`)

Greedy best-first pathfinding (not full A\* — the grid is simple and targets change every 3s):

1. From current position, compute the cardinal direction (up/down/left/right) that minimizes Manhattan distance to target
2. If that cell is occupied by another player, try the perpendicular directions
3. If all adjacent cells are blocked, stay put (will retry next tick)
4. Returns a single `{ dx, dy }` per call

No need for full A\* since:

- No walls or obstacles on the board
- Targets refresh every 3 seconds
- The only "obstacle" is other players (temporary)

### Move Execution

Reuses the same logic as `TerritoryGame.tsx` `doMove`:

1. Check stun status
2. Clamp to board bounds
3. Check collision with other players → stun both if collision
4. Update position in Yjs players map
5. Claim cell in Yjs cells map
6. Run `findEnclosedCells` and fill enclosed regions

The `findEnclosedCells` function is extracted from `TerritoryGame.tsx` into a shared module so both browser and server can use it.

## File Changes

### New files

| File                        | Purpose                                                                       |
| --------------------------- | ----------------------------------------------------------------------------- |
| `server.ts`                 | Entry point, reads env vars, starts agent server                              |
| `src/agent/agent-server.ts` | Room watcher, agent lifecycle management                                      |
| `src/agent/ai-player.ts`    | Single AI player: Yjs connection + game loop                                  |
| `src/agent/haiku-client.ts` | Anthropic API calls, prompt building, response parsing                        |
| `src/agent/pathfinder.ts`   | Greedy pathfinding toward target                                              |
| `src/utils/game-logic.ts`   | Shared game logic: `findEnclosedCells`, board reading helpers, game constants |

### Modified files

| File                               | Changes                                                                                                                                                     |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/components/TerritoryGame.tsx` | Import shared logic from `game-logic.ts`; update `WIN_THRESHOLD` to 0.2; add game timer (2min); adjust `CELL` size and grid line rendering for large boards |
| `src/components/Lobby.tsx`         | Add 512x512 to `BOARD_SIZES`; update win description text                                                                                                   |
| `package.json`                     | Add `@anthropic-ai/sdk` dependency                                                                                                                          |
| `.env`                             | Add `ANTHROPIC_API_KEY`                                                                                                                                     |
| `.env.example`                     | Add `ANTHROPIC_API_KEY` placeholder                                                                                                                         |

## Game Timer Implementation

A shared `Y.Map("gameState")` stores:

- `gameStartedAt: number` — timestamp set by the first player to join
- `gameEndedAt: number | null` — set when someone wins or timer expires

The first player (human or bot) to join writes `gameStartedAt` if it is not already set (check-then-set in a Yjs transaction).

Timer logic (both browser and server):

- On cell change, check if any player has >= 20% → set winner
- Every second, check if `Date.now() - gameStartedAt >= 120000` → find highest % player, set winner
- Winner display shows the winning player's name and their territory %
- When game ends, bots stop moving (check `gameEndedAt` in move loop)

## Bot Names

10 bots use NATO phonetic alphabet: Alpha, Bravo, Charlie, Delta, Echo, Foxtrot, Golf, Hotel, India, Juliet. Displayed as "Bot-Alpha", "Bot-Bravo", etc.

## Dependencies

Add to `package.json`:

```json
{
  "dependencies": {
    "@anthropic-ai/sdk": "^0.52.0"
  }
}
```

The server reuses existing dependencies: `yjs`, `y-protocols`, `@durable-streams/client`, `@durable-streams/state`, `@durable-streams/y-durable-streams`.

## Running

```sh
# Terminal 1: game client
pnpm dev

# Terminal 2: AI agent server
pnpm dev:server
```

Both read from the same `.env` file. The server uses `dotenv` or `tsx` env loading to read `VITE_*` vars + `ANTHROPIC_API_KEY`.
