# Phase 10: Testing

## Goal

Implement comprehensive testing: unit tests, component tests, integration tests, and E2E tests.

## Dependencies

- All previous phases

## Tasks

### 10.1 Test Configuration

Create `vitest.config.ts`:

```typescript
import { defineConfig } from "vitest/config"
import react from "@vitejs/plugin-react"
import path from "path"

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}", "tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      exclude: ["node_modules/", "tests/"],
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
})
```

Create `tests/setup.ts`:

```typescript
import "@testing-library/jest-dom"
import { vi } from "vitest"

// Mock localStorage
const localStorageMock = {
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
}
Object.defineProperty(window, "localStorage", { value: localStorageMock })

// Mock matchMedia
Object.defineProperty(window, "matchMedia", {
  value: vi.fn().mockImplementation((query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
})

// Mock ResizeObserver
class ResizeObserverMock {
  observe = vi.fn()
  unobserve = vi.fn()
  disconnect = vi.fn()
}
window.ResizeObserver = ResizeObserverMock
```

Create `playwright.config.ts`:

```typescript
import { defineConfig, devices } from "@playwright/test"

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "html",
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "Mobile Chrome",
      use: { ...devices["Pixel 5"] },
    },
    {
      name: "Mobile Safari",
      use: { ...devices["iPhone 13"] },
    },
  ],
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
  },
})
```

### 10.2 Unit Tests for Edge Math

Create `src/lib/edge-math.test.ts`:

```typescript
import { describe, it, expect } from "vitest"
import {
  edgeIdToCoords,
  coordsToEdgeId,
  isHorizontal,
  getAdjacentBoxes,
  getBoxEdges,
  boxCoordsToId,
  boxIdToCoords,
  isValidEdgeId,
  HORIZ_COUNT,
  VERT_COUNT,
  EDGE_COUNT,
  W,
  H,
} from "./edge-math"

describe("edge-math", () => {
  describe("constants", () => {
    it("has correct edge counts", () => {
      expect(HORIZ_COUNT).toBe(1001000)
      expect(VERT_COUNT).toBe(1001000)
      expect(EDGE_COUNT).toBe(2002000)
    })
  })

  describe("edgeIdToCoords", () => {
    it("handles horizontal edge at origin", () => {
      expect(edgeIdToCoords(0)).toEqual({ x: 0, y: 0, horizontal: true })
    })

    it("handles horizontal edge at end of row", () => {
      expect(edgeIdToCoords(999)).toEqual({ x: 999, y: 0, horizontal: true })
    })

    it("handles horizontal edge on second row", () => {
      expect(edgeIdToCoords(1000)).toEqual({ x: 0, y: 1, horizontal: true })
    })

    it("handles first vertical edge", () => {
      expect(edgeIdToCoords(HORIZ_COUNT)).toEqual({
        x: 0,
        y: 0,
        horizontal: false,
      })
    })

    it("handles last edge", () => {
      expect(edgeIdToCoords(EDGE_COUNT - 1)).toEqual({
        x: 1000,
        y: 999,
        horizontal: false,
      })
    })
  })

  describe("coordsToEdgeId", () => {
    it("round-trips horizontal edges", () => {
      const samples = [
        { x: 0, y: 0 },
        { x: 999, y: 0 },
        { x: 500, y: 500 },
        { x: 0, y: 1000 },
      ]

      for (const { x, y } of samples) {
        const id = coordsToEdgeId(x, y, true)
        const coords = edgeIdToCoords(id)
        expect(coords).toEqual({ x, y, horizontal: true })
      }
    })

    it("round-trips vertical edges", () => {
      const samples = [
        { x: 0, y: 0 },
        { x: 1000, y: 0 },
        { x: 500, y: 500 },
        { x: 0, y: 999 },
      ]

      for (const { x, y } of samples) {
        const id = coordsToEdgeId(x, y, false)
        const coords = edgeIdToCoords(id)
        expect(coords).toEqual({ x, y, horizontal: false })
      }
    })
  })

  describe("isHorizontal", () => {
    it("returns true for horizontal edges", () => {
      expect(isHorizontal(0)).toBe(true)
      expect(isHorizontal(HORIZ_COUNT - 1)).toBe(true)
    })

    it("returns false for vertical edges", () => {
      expect(isHorizontal(HORIZ_COUNT)).toBe(false)
      expect(isHorizontal(EDGE_COUNT - 1)).toBe(false)
    })
  })

  describe("getAdjacentBoxes", () => {
    it("returns 2 boxes for interior horizontal edge", () => {
      const id = coordsToEdgeId(500, 500, true)
      const boxes = getAdjacentBoxes(id)
      expect(boxes).toHaveLength(2)
      expect(boxes).toContainEqual({ x: 500, y: 499 })
      expect(boxes).toContainEqual({ x: 500, y: 500 })
    })

    it("returns 1 box for top edge", () => {
      const boxes = getAdjacentBoxes(coordsToEdgeId(0, 0, true))
      expect(boxes).toHaveLength(1)
      expect(boxes[0]).toEqual({ x: 0, y: 0 })
    })

    it("returns 1 box for bottom edge", () => {
      const boxes = getAdjacentBoxes(coordsToEdgeId(0, H, true))
      expect(boxes).toHaveLength(1)
      expect(boxes[0]).toEqual({ x: 0, y: H - 1 })
    })

    it("returns 2 boxes for interior vertical edge", () => {
      const id = coordsToEdgeId(500, 500, false)
      const boxes = getAdjacentBoxes(id)
      expect(boxes).toHaveLength(2)
    })

    it("returns 1 box for left edge", () => {
      const boxes = getAdjacentBoxes(coordsToEdgeId(0, 0, false))
      expect(boxes).toHaveLength(1)
    })
  })

  describe("getBoxEdges", () => {
    it("returns 4 edges for box (0,0)", () => {
      const edges = getBoxEdges(0, 0)
      expect(edges).toHaveLength(4)
      expect(edges[0]).toBe(coordsToEdgeId(0, 0, true)) // top
      expect(edges[1]).toBe(coordsToEdgeId(0, 1, true)) // bottom
      expect(edges[2]).toBe(coordsToEdgeId(0, 0, false)) // left
      expect(edges[3]).toBe(coordsToEdgeId(1, 0, false)) // right
    })
  })

  describe("isValidEdgeId", () => {
    it("returns true for valid edges", () => {
      expect(isValidEdgeId(0)).toBe(true)
      expect(isValidEdgeId(EDGE_COUNT - 1)).toBe(true)
    })

    it("returns false for invalid edges", () => {
      expect(isValidEdgeId(-1)).toBe(false)
      expect(isValidEdgeId(EDGE_COUNT)).toBe(false)
      expect(isValidEdgeId(1.5)).toBe(false)
    })
  })
})
```

### 10.3 Unit Tests for Game State

Create `src/lib/game-state.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest"
import { GameState } from "./game-state"
import { getBoxEdges, EDGE_COUNT } from "./edge-math"

describe("GameState", () => {
  let state: GameState

  beforeEach(() => {
    state = new GameState()
  })

  describe("initial state", () => {
    it("has no edges taken", () => {
      expect(state.getEdgesPlacedCount()).toBe(0)
    })

    it("has all zero scores", () => {
      expect(state.getScores()).toEqual([0, 0, 0, 0])
    })

    it("is not complete", () => {
      expect(state.isComplete()).toBe(false)
    })
  })

  describe("applyEvent", () => {
    it("marks edge as taken", () => {
      state.applyEvent({ edgeId: 0, teamId: 0 })
      expect(state.isEdgeTaken(0)).toBe(true)
      expect(state.getEdgesPlacedCount()).toBe(1)
    })

    it("ignores duplicate edge", () => {
      state.applyEvent({ edgeId: 0, teamId: 0 })
      state.applyEvent({ edgeId: 0, teamId: 1 })
      expect(state.getEdgesPlacedCount()).toBe(1)
    })

    it("claims box when completed", () => {
      const edges = getBoxEdges(0, 0)

      // Place first 3 edges
      state.applyEvent({ edgeId: edges[0], teamId: 0 })
      state.applyEvent({ edgeId: edges[1], teamId: 1 })
      state.applyEvent({ edgeId: edges[2], teamId: 2 })

      expect(state.getBoxOwner(0)).toBe(0)

      // Place 4th edge
      const result = state.applyEvent({ edgeId: edges[3], teamId: 3 })

      expect(state.getBoxOwner(0)).toBe(4) // teamId + 1
      expect(state.getScore(3)).toBe(1)
      expect(result.boxesClaimed).toContain(0)
    })
  })

  describe("scores", () => {
    it("increments correct team on claim", () => {
      completeBox(state, 0, 0, 2)
      expect(state.getScore(2)).toBe(1)
      expect(state.getScores()).toEqual([0, 0, 1, 0])
    })

    it("accumulates multiple claims", () => {
      completeBox(state, 0, 0, 0)
      completeBox(state, 1, 0, 0)
      completeBox(state, 0, 1, 1)

      expect(state.getScore(0)).toBe(2)
      expect(state.getScore(1)).toBe(1)
    })
  })

  describe("getWinner", () => {
    it("returns null for tie", () => {
      completeBox(state, 0, 0, 0)
      completeBox(state, 1, 0, 1)
      expect(state.getWinner()).toBe(null)
    })

    it("returns winning team", () => {
      completeBox(state, 0, 0, 2)
      completeBox(state, 1, 0, 2)
      completeBox(state, 2, 0, 3)
      expect(state.getWinner()).toBe(2)
    })
  })

  describe("serialization", () => {
    it("exports and imports correctly", () => {
      state.applyEvent({ edgeId: 100, teamId: 1 })
      state.applyEvent({ edgeId: 200, teamId: 2 })

      const exported = state.export()
      const imported = GameState.import(exported)

      expect(imported.isEdgeTaken(100)).toBe(true)
      expect(imported.isEdgeTaken(200)).toBe(true)
      expect(imported.isEdgeTaken(300)).toBe(false)
      expect(imported.getEdgesPlacedCount()).toBe(2)
    })
  })
})

function completeBox(
  state: GameState,
  x: number,
  y: number,
  finalTeam: number
) {
  const edges = getBoxEdges(x, y)
  edges
    .slice(0, 3)
    .forEach((e, i) => state.applyEvent({ edgeId: e, teamId: i % 4 }))
  state.applyEvent({ edgeId: edges[3], teamId: finalTeam })
}
```

### 10.4 Component Tests

Create `src/components/ui/QuotaMeter.test.tsx`:

```typescript
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QuotaMeter } from './QuotaMeter';

// Mock the context
vi.mock('../../contexts/quota-context', () => ({
  useQuota: () => ({
    remaining: 6,
    max: 8,
    refillIn: 5,
    consume: vi.fn(),
    refund: vi.fn(),
  }),
}));

describe('QuotaMeter', () => {
  it('displays remaining quota', () => {
    render(<QuotaMeter />);
    expect(screen.getByText('6/8 lines')).toBeInTheDocument();
  });

  it('shows refill timer', () => {
    render(<QuotaMeter />);
    expect(screen.getByText('+1 in 5s')).toBeInTheDocument();
  });

  it('has correct data-testid', () => {
    render(<QuotaMeter />);
    expect(screen.getByTestId('quota-meter')).toBeInTheDocument();
  });
});
```

### 10.5 E2E Tests

Create `tests/e2e/game-flow.spec.ts`:

```typescript
import { test, expect } from "@playwright/test"

test.describe("Game Flow", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await page.waitForLoadState("networkidle")
  })

  test("displays all main UI elements", async ({ page }) => {
    await expect(page.getByTestId("header")).toBeVisible()
    await expect(page.getByTestId("footer")).toBeVisible()
    await expect(page.getByTestId("team-badge")).toBeVisible()
    await expect(page.getByTestId("quota-meter")).toBeVisible()
    await expect(page.getByTestId("scoreboard")).toBeVisible()
    await expect(page.getByTestId("world-view")).toBeVisible()
    await expect(page.getByTestId("game-canvas")).toBeVisible()
  })

  test("team badge shows valid team", async ({ page }) => {
    const badge = page.getByTestId("team-badge")
    const text = await badge.textContent()
    expect(
      ["RED", "BLUE", "GREEN", "YELLOW"].some((t) => text?.includes(t))
    ).toBe(true)
  })

  test("quota meter shows 8 max", async ({ page }) => {
    const quota = page.getByTestId("quota-meter")
    await expect(quota).toContainText("/8")
  })

  test("zoom controls work", async ({ page }) => {
    const zoomIn = page.getByTestId("zoom-in")
    const zoomOut = page.getByTestId("zoom-out")

    await expect(zoomIn).toBeVisible()
    await expect(zoomOut).toBeVisible()

    await zoomIn.click()
    await zoomIn.click()
    await zoomOut.click()
  })

  test("world view is clickable", async ({ page }) => {
    const worldView = page.getByTestId("world-view")
    await worldView.click({ position: { x: 75, y: 75 } })
  })
})

test.describe("Game Interaction", () => {
  test("canvas responds to mouse move", async ({ page }) => {
    await page.goto("/")
    await page.waitForLoadState("networkidle")

    // Zoom in first
    await page.getByTestId("zoom-in").click()
    await page.getByTestId("zoom-in").click()
    await page.getByTestId("zoom-in").click()

    const canvas = page.getByTestId("game-canvas")
    await canvas.hover({ position: { x: 200, y: 200 } })
  })
})
```

Create `tests/e2e/mobile.spec.ts`:

```typescript
import { test, expect, devices } from "@playwright/test"

test.use({ ...devices["iPhone 13"] })

test.describe("Mobile", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await page.waitForLoadState("networkidle")
  })

  test("displays mobile layout", async ({ page }) => {
    await expect(page.getByTestId("header")).toBeVisible()
    await expect(page.getByTestId("footer")).toBeVisible()
  })

  test("touch targets are large enough", async ({ page }) => {
    const zoomIn = page.getByTestId("zoom-in")
    const box = await zoomIn.boundingBox()

    expect(box?.width).toBeGreaterThanOrEqual(44)
    expect(box?.height).toBeGreaterThanOrEqual(44)
  })

  test("world view is visible", async ({ page }) => {
    const worldView = page.getByTestId("world-view")
    await expect(worldView).toBeVisible()
  })
})
```

### 10.6 Integration Tests

Create `tests/integration/stream-replay.test.ts`:

```typescript
import { describe, it, expect } from "vitest"
import { GameState } from "../../src/lib/game-state"
import { parseStreamRecords, encodeEvent } from "../../src/lib/stream-parser"

describe("Stream Replay", () => {
  it("replays empty stream", () => {
    const state = new GameState()
    const records = parseStreamRecords(new Uint8Array(0))

    records.forEach((r) => state.applyEvent(r))

    expect(state.getEdgesPlacedCount()).toBe(0)
  })

  it("replays single record", () => {
    const state = new GameState()
    const event = { edgeId: 100, teamId: 2 }
    const bytes = encodeEvent(event)
    const records = parseStreamRecords(bytes)

    expect(records).toHaveLength(1)
    expect(records[0]).toEqual(event)

    records.forEach((r) => state.applyEvent(r))
    expect(state.isEdgeTaken(100)).toBe(true)
  })

  it("replays multiple records", () => {
    const events = [
      { edgeId: 0, teamId: 0 },
      { edgeId: 100, teamId: 1 },
      { edgeId: 200, teamId: 2 },
    ]

    const bytes = new Uint8Array(events.length * 3)
    events.forEach((e, i) => {
      const encoded = encodeEvent(e)
      bytes.set(encoded, i * 3)
    })

    const records = parseStreamRecords(bytes)
    expect(records).toHaveLength(3)

    const state = new GameState()
    records.forEach((r) => state.applyEvent(r))

    expect(state.getEdgesPlacedCount()).toBe(3)
  })

  it("handles partial records", () => {
    const bytes = new Uint8Array([0x00, 0x01, 0x92, 0xff]) // 1 complete + 1 byte
    const records = parseStreamRecords(bytes)
    expect(records).toHaveLength(1)
  })
})
```

### 10.7 Update Package Scripts

Add to `package.json`:

```json
{
  "scripts": {
    "test": "vitest",
    "test:unit": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage",
    "test:e2e": "playwright test",
    "test:e2e:headed": "playwright test --headed",
    "test:e2e:debug": "playwright test --debug",
    "test:all": "pnpm test:unit && pnpm test:e2e"
  }
}
```

## Deliverables

- [ ] `vitest.config.ts` — Vitest configuration
- [ ] `playwright.config.ts` — Playwright configuration
- [ ] `tests/setup.ts` — Test setup with mocks
- [ ] Unit tests for `edge-math.ts`
- [ ] Unit tests for `game-state.ts`
- [ ] Unit tests for `stream-parser.ts`
- [ ] Component tests for UI components
- [ ] E2E tests for game flow
- [ ] E2E tests for mobile
- [ ] Integration tests for stream replay
- [ ] All tests passing
- [ ] Coverage report generated

## Next Phase

→ `11-polish-deploy.md`
