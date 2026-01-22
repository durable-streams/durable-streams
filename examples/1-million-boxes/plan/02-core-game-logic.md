# Phase 02: Core Game Logic

## Goal

Implement the pure TypeScript game logic: edge math, game state management, and stream parsing. This code has no dependencies on React or Cloudflare—it's portable and testable.

## Dependencies

- Phase 01 (Project Setup)

## Tasks

### 2.1 Edge Math Library

Create `src/lib/edge-math.ts`:

```typescript
// Constants
export const W = 1000
export const H = 1000
export const HORIZ_COUNT = W * (H + 1) // 1,001,000
export const VERT_COUNT = (W + 1) * H // 1,001,000
export const EDGE_COUNT = HORIZ_COUNT + VERT_COUNT // 2,002,000
export const BOX_COUNT = W * H // 1,000,000

// Types
export interface EdgeCoords {
  x: number
  y: number
  horizontal: boolean
}

export interface BoxCoords {
  x: number
  y: number
}

// Edge ID → Coordinates
export function edgeIdToCoords(edgeId: number): EdgeCoords {
  if (edgeId < HORIZ_COUNT) {
    // Horizontal edge
    const y = Math.floor(edgeId / W)
    const x = edgeId % W
    return { x, y, horizontal: true }
  } else {
    // Vertical edge
    const idx = edgeId - HORIZ_COUNT
    const y = Math.floor(idx / (W + 1))
    const x = idx % (W + 1)
    return { x, y, horizontal: false }
  }
}

// Coordinates → Edge ID
export function coordsToEdgeId(
  x: number,
  y: number,
  horizontal: boolean
): number {
  if (horizontal) {
    return y * W + x
  } else {
    return HORIZ_COUNT + y * (W + 1) + x
  }
}

// Check if edge ID is horizontal
export function isHorizontal(edgeId: number): boolean {
  return edgeId < HORIZ_COUNT
}

// Get adjacent boxes for an edge (0, 1, or 2 boxes)
export function getAdjacentBoxes(edgeId: number): BoxCoords[] {
  const boxes: BoxCoords[] = []
  const coords = edgeIdToCoords(edgeId)

  if (coords.horizontal) {
    // Horizontal edge at (x, y) borders boxes at (x, y-1) and (x, y)
    if (coords.y > 0) {
      boxes.push({ x: coords.x, y: coords.y - 1 })
    }
    if (coords.y < H) {
      boxes.push({ x: coords.x, y: coords.y })
    }
  } else {
    // Vertical edge at (x, y) borders boxes at (x-1, y) and (x, y)
    if (coords.x > 0) {
      boxes.push({ x: coords.x - 1, y: coords.y })
    }
    if (coords.x < W) {
      boxes.push({ x: coords.x, y: coords.y })
    }
  }

  return boxes
}

// Get the four edge IDs surrounding a box
export function getBoxEdges(
  x: number,
  y: number
): [number, number, number, number] {
  const top = y * W + x
  const bottom = (y + 1) * W + x
  const left = HORIZ_COUNT + y * (W + 1) + x
  const right = HORIZ_COUNT + y * (W + 1) + (x + 1)
  return [top, bottom, left, right]
}

// Box coordinates → Box ID
export function boxCoordsToId(x: number, y: number): number {
  return y * W + x
}

// Box ID → Box coordinates
export function boxIdToCoords(boxId: number): BoxCoords {
  return {
    x: boxId % W,
    y: Math.floor(boxId / W),
  }
}

// Validate edge ID
export function isValidEdgeId(edgeId: number): boolean {
  return Number.isInteger(edgeId) && edgeId >= 0 && edgeId < EDGE_COUNT
}
```

### 2.2 Game State Class

Create `src/lib/game-state.ts`:

```typescript
import {
  EDGE_COUNT,
  BOX_COUNT,
  W,
  getAdjacentBoxes,
  getBoxEdges,
  boxCoordsToId,
} from "./edge-math"

export interface GameEvent {
  edgeId: number
  teamId: number // 0-3
}

export class GameState {
  // Edge bitset: 1 bit per edge
  private edgeTaken: Uint8Array

  // Box ownership: 0 = unclaimed, 1-4 = team (teamId + 1)
  private boxOwner: Uint8Array

  // Team scores
  private scores: [number, number, number, number]

  // Count of placed edges
  private edgesPlacedCount: number

  constructor() {
    this.edgeTaken = new Uint8Array(Math.ceil(EDGE_COUNT / 8))
    this.boxOwner = new Uint8Array(BOX_COUNT)
    this.scores = [0, 0, 0, 0]
    this.edgesPlacedCount = 0
  }

  // Check if edge is taken
  isEdgeTaken(edgeId: number): boolean {
    const byteIndex = edgeId >> 3
    const bitMask = 1 << (edgeId & 7)
    return (this.edgeTaken[byteIndex] & bitMask) !== 0
  }

  // Set edge as taken (internal)
  private setEdgeTaken(edgeId: number): void {
    const byteIndex = edgeId >> 3
    const bitMask = 1 << (edgeId & 7)
    this.edgeTaken[byteIndex] |= bitMask
  }

  // Apply a game event
  applyEvent(event: GameEvent): { boxesClaimed: number[] } {
    const { edgeId, teamId } = event
    const boxesClaimed: number[] = []

    // Ignore if already taken (shouldn't happen with valid stream)
    if (this.isEdgeTaken(edgeId)) {
      return { boxesClaimed }
    }

    // Mark edge as taken
    this.setEdgeTaken(edgeId)
    this.edgesPlacedCount++

    // Check adjacent boxes for completion
    const adjacentBoxes = getAdjacentBoxes(edgeId)

    for (const box of adjacentBoxes) {
      const boxId = boxCoordsToId(box.x, box.y)

      // Skip if already claimed
      if (this.boxOwner[boxId] !== 0) continue

      // Check if all four edges are now set
      const [top, bottom, left, right] = getBoxEdges(box.x, box.y)

      if (
        this.isEdgeTaken(top) &&
        this.isEdgeTaken(bottom) &&
        this.isEdgeTaken(left) &&
        this.isEdgeTaken(right)
      ) {
        // Box is complete - claim it
        this.boxOwner[boxId] = teamId + 1
        this.scores[teamId]++
        boxesClaimed.push(boxId)
      }
    }

    return { boxesClaimed }
  }

  // Getters
  getBoxOwner(boxId: number): number {
    return this.boxOwner[boxId]
  }

  getScore(teamId: number): number {
    return this.scores[teamId]
  }

  getScores(): [number, number, number, number] {
    return [...this.scores] as [number, number, number, number]
  }

  getEdgesPlacedCount(): number {
    return this.edgesPlacedCount
  }

  isComplete(): boolean {
    return this.edgesPlacedCount === EDGE_COUNT
  }

  // Get winning team (or null if tie)
  getWinner(): number | null {
    const maxScore = Math.max(...this.scores)
    const winners = this.scores
      .map((s, i) => (s === maxScore ? i : -1))
      .filter((i) => i !== -1)
    return winners.length === 1 ? winners[0] : null
  }

  // Export for serialization (optional)
  export(): {
    edgeTaken: Uint8Array
    boxOwner: Uint8Array
    scores: number[]
    edgesPlaced: number
  } {
    return {
      edgeTaken: new Uint8Array(this.edgeTaken),
      boxOwner: new Uint8Array(this.boxOwner),
      scores: [...this.scores],
      edgesPlaced: this.edgesPlacedCount,
    }
  }

  // Import from serialization (optional)
  static import(data: {
    edgeTaken: Uint8Array
    boxOwner: Uint8Array
    scores: number[]
    edgesPlaced: number
  }): GameState {
    const state = new GameState()
    state.edgeTaken.set(data.edgeTaken)
    state.boxOwner.set(data.boxOwner)
    state.scores = data.scores as [number, number, number, number]
    state.edgesPlacedCount = data.edgesPlaced
    return state
  }
}
```

### 2.3 Stream Parser

Create `src/lib/stream-parser.ts`:

```typescript
import { GameEvent } from "./game-state"

// Parse 3-byte records from binary stream data
export function parseStreamRecords(bytes: Uint8Array): GameEvent[] {
  const events: GameEvent[] = []
  const recordCount = Math.floor(bytes.length / 3)

  for (let i = 0; i < recordCount; i++) {
    const offset = i * 3

    // Big-endian 24-bit packed value
    const packed =
      (bytes[offset] << 16) | (bytes[offset + 1] << 8) | bytes[offset + 2]

    const edgeId = packed >> 2
    const teamId = packed & 0b11

    events.push({ edgeId, teamId })
  }

  return events
}

// Encode a single event to 3 bytes
export function encodeEvent(event: GameEvent): Uint8Array {
  const packed = (event.edgeId << 2) | event.teamId
  return new Uint8Array([
    (packed >> 16) & 0xff,
    (packed >> 8) & 0xff,
    packed & 0xff,
  ])
}

// Streaming parser for incremental updates
export class StreamParser {
  private buffer: Uint8Array = new Uint8Array(0)

  // Feed bytes and get complete events
  feed(chunk: Uint8Array): GameEvent[] {
    // Combine with existing buffer
    const combined = new Uint8Array(this.buffer.length + chunk.length)
    combined.set(this.buffer)
    combined.set(chunk, this.buffer.length)

    // Parse complete records
    const recordCount = Math.floor(combined.length / 3)
    const events = parseStreamRecords(combined.slice(0, recordCount * 3))

    // Keep remainder in buffer
    this.buffer = combined.slice(recordCount * 3)

    return events
  }

  // Reset parser state
  reset(): void {
    this.buffer = new Uint8Array(0)
  }
}
```

### 2.4 Team Utilities

Create `src/lib/teams.ts`:

```typescript
export const TEAMS = ["RED", "BLUE", "GREEN", "YELLOW"] as const
export type TeamName = (typeof TEAMS)[number]

export const TEAM_COLORS = {
  RED: { primary: "#E53935", fill: "rgba(229, 57, 53, 0.5)" },
  BLUE: { primary: "#1E88E5", fill: "rgba(30, 136, 229, 0.5)" },
  GREEN: { primary: "#43A047", fill: "rgba(67, 160, 71, 0.5)" },
  YELLOW: { primary: "#FDD835", fill: "rgba(253, 216, 53, 0.5)" },
} as const

export function teamIdToName(teamId: number): TeamName {
  return TEAMS[teamId]
}

export function teamNameToId(name: TeamName): number {
  return TEAMS.indexOf(name)
}

export function getTeamColor(teamId: number): {
  primary: string
  fill: string
} {
  return TEAM_COLORS[TEAMS[teamId]]
}
```

### 2.5 Write Unit Tests

Create `src/lib/edge-math.test.ts`:

```typescript
import { describe, it, expect } from "vitest"
import {
  edgeIdToCoords,
  coordsToEdgeId,
  isHorizontal,
  getAdjacentBoxes,
  getBoxEdges,
  HORIZ_COUNT,
  EDGE_COUNT,
  W,
  H,
} from "./edge-math"

describe("edge-math", () => {
  describe("edgeIdToCoords / coordsToEdgeId", () => {
    it("handles horizontal edge at origin", () => {
      const coords = edgeIdToCoords(0)
      expect(coords).toEqual({ x: 0, y: 0, horizontal: true })
      expect(coordsToEdgeId(0, 0, true)).toBe(0)
    })

    it("handles last horizontal edge", () => {
      const coords = edgeIdToCoords(HORIZ_COUNT - 1)
      expect(coords).toEqual({ x: W - 1, y: H, horizontal: true })
    })

    it("handles first vertical edge", () => {
      const coords = edgeIdToCoords(HORIZ_COUNT)
      expect(coords).toEqual({ x: 0, y: 0, horizontal: false })
      expect(coordsToEdgeId(0, 0, false)).toBe(HORIZ_COUNT)
    })

    it("round-trips correctly", () => {
      const samples = [0, 1, 999, HORIZ_COUNT, HORIZ_COUNT + 1, EDGE_COUNT - 1]
      for (const id of samples) {
        const coords = edgeIdToCoords(id)
        const back = coordsToEdgeId(coords.x, coords.y, coords.horizontal)
        expect(back).toBe(id)
      }
    })
  })

  describe("getAdjacentBoxes", () => {
    it("returns 2 boxes for interior edge", () => {
      const boxes = getAdjacentBoxes(coordsToEdgeId(500, 500, true))
      expect(boxes).toHaveLength(2)
    })

    it("returns 1 box for boundary edge", () => {
      const boxes = getAdjacentBoxes(0) // Top-left horizontal
      expect(boxes).toHaveLength(1)
    })
  })

  describe("getBoxEdges", () => {
    it("returns 4 edges for box (0,0)", () => {
      const edges = getBoxEdges(0, 0)
      expect(edges).toHaveLength(4)
      expect(edges[0]).toBe(0) // top
      expect(edges[1]).toBe(W) // bottom
      expect(edges[2]).toBe(HORIZ_COUNT) // left
      expect(edges[3]).toBe(HORIZ_COUNT + 1) // right
    })
  })
})
```

Create `src/lib/game-state.test.ts` and `src/lib/stream-parser.test.ts` with tests from SPEC.md Section 14.3.

## Deliverables

- [ ] `src/lib/edge-math.ts` — Edge ID ↔ coordinate conversions
- [ ] `src/lib/game-state.ts` — GameState class with bitset and fold
- [ ] `src/lib/stream-parser.ts` — Binary stream parsing
- [ ] `src/lib/teams.ts` — Team constants and utilities
- [ ] Unit tests for all libraries
- [ ] All tests passing

## Next Phase

→ `03-backend-server.md`
