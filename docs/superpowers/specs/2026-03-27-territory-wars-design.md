# Territory Wars — Design Spec

## Overview

Real-time multiplayer grid painting game. Players move freely on a grid, claiming cells by stepping on them. Each cell is a Y.Map CRDT entry — LWW resolves contention. First player to control 50% of the board wins. Collision stuns both players briefly.

## Data Model

### Y.Map `cells` — board state

- Key: `"x,y"` string
- Value: `{ owner: string, claimedAt: number }`
- Any player writes on movement, Yjs LWW resolves conflicts

### Y.Map `players` — player positions

- Key: `playerId`
- Value: `{ x: number, y: number, name: string, color: string, stunnedUntil?: number }`

No single-writer election needed. Every write is a player claiming a cell or updating position. Pure CRDT.

## Game Mechanics

### Movement

- Event-driven, not tick-based
- Key down starts moving in direction (repeats every ~120ms while held)
- Key up stops movement
- On each move: write position to `players` map, write cell to `cells` map
- Mobile: swipe gestures (same as snake)

### Collision

- If new position matches another player's position, both get stunned for 1.5s
- Stunned players can't move
- Visual: pulsing/dimmed cursor

### Win condition

- 50% of total cells claimed by one player
- Score derived live from Y.Map cell count
- Win overlay shown, board resets after short delay

## Rendering

- SVG grid, same pixel aesthetic as snake (Electric SQL palette)
- Cell size: 14px (smaller than snake's 20px for more territory)
- Default board: 30x30 (900 cells, win at 450)
- Unclaimed cells: grid background
- Claimed cells: player color at 0.6 opacity
- Player cursor: full opacity, bordered
- Stunned: pulsing animation

## Project Structure

Reorganize `examples/y-snake` → `examples/y-games` with shared infrastructure:

```
examples/y-games/
├── src/
│   ├── shared/
│   │   ├── server-endpoint-context.tsx
│   │   ├── registry-context.tsx
│   │   ├── scores-context.tsx
│   │   ├── game-room-context.tsx
│   │   ├── GameRoom.tsx
│   │   ├── Lobby.tsx (configurable via props)
│   │   ├── palette.ts
│   │   └── schemas.ts
│   ├── snake/
│   │   ├── SnakeGame.tsx
│   │   └── config.ts
│   ├── territory/
│   │   ├── TerritoryGame.tsx
│   │   └── config.ts
│   ├── App.tsx (game selector + routing)
│   └── main.tsx
```

## Shared Infrastructure Changes

- `Lobby.tsx`: accept game config as props (board sizes, name generator)
- `registry-context.tsx`: parameterize stream name prefix
- `scores-context.tsx`: parameterize stream prefix
- `palette.ts`: extract shared PALETTE and font constants
- `GameRoom.tsx`: pass game component as prop instead of hardcoding SnakeGame

## Reused As-Is

- ServerEndpointProvider
- GameRoomContext interface
- Awareness-based presence
- Hash-based routing pattern
- Swipe gesture input
- Press Start 2P font + dark theme
