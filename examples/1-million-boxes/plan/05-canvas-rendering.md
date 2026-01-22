# Phase 05: Canvas Rendering

## Goal

Implement the main game canvas with pan/zoom, hand-drawn edge rendering, and box fill rendering.

## Dependencies

- Phase 02 (Core Game Logic)
- Phase 04 (Frontend Foundation)

## Tasks

### 5.1 View State Hook

Create `src/hooks/useViewState.ts`:

```typescript
import { useState, useCallback } from "react"
import { W, H } from "../lib/edge-math"

export interface ViewState {
  centerX: number // 0..1000
  centerY: number // 0..1000
  zoom: number // 0.1..10
}

const MIN_ZOOM = 0.1
const MAX_ZOOM = 10
const DEFAULT_ZOOM = 1

export function useViewState() {
  const [view, setView] = useState<ViewState>({
    centerX: W / 2,
    centerY: H / 2,
    zoom: DEFAULT_ZOOM,
  })

  const pan = useCallback((deltaX: number, deltaY: number) => {
    setView((v) => ({
      ...v,
      centerX: Math.max(0, Math.min(W, v.centerX - deltaX / v.zoom)),
      centerY: Math.max(0, Math.min(H, v.centerY - deltaY / v.zoom)),
    }))
  }, [])

  const zoomTo = useCallback(
    (newZoom: number, focalX?: number, focalY?: number) => {
      setView((v) => {
        const clampedZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, newZoom))

        // If focal point provided, adjust center to keep that point fixed
        if (focalX !== undefined && focalY !== undefined) {
          const scale = clampedZoom / v.zoom
          return {
            centerX: focalX + (v.centerX - focalX) / scale,
            centerY: focalY + (v.centerY - focalY) / scale,
            zoom: clampedZoom,
          }
        }

        return { ...v, zoom: clampedZoom }
      })
    },
    []
  )

  const zoomIn = useCallback(() => {
    zoomTo(view.zoom * 1.5)
  }, [view.zoom, zoomTo])

  const zoomOut = useCallback(() => {
    zoomTo(view.zoom / 1.5)
  }, [view.zoom, zoomTo])

  const resetView = useCallback(() => {
    setView({
      centerX: W / 2,
      centerY: H / 2,
      zoom: DEFAULT_ZOOM,
    })
  }, [])

  const jumpTo = useCallback((x: number, y: number) => {
    setView((v) => ({
      ...v,
      centerX: Math.max(0, Math.min(W, x)),
      centerY: Math.max(0, Math.min(H, y)),
    }))
  }, [])

  return {
    view,
    pan,
    zoomTo,
    zoomIn,
    zoomOut,
    resetView,
    jumpTo,
  }
}
```

### 5.2 Coordinate Transform Utilities

Create `src/lib/view-transform.ts`:

```typescript
import { ViewState } from "../hooks/useViewState"

// World coordinates to screen coordinates
export function worldToScreen(
  wx: number,
  wy: number,
  view: ViewState,
  canvasWidth: number,
  canvasHeight: number
): { x: number; y: number } {
  const cx = canvasWidth / 2
  const cy = canvasHeight / 2
  return {
    x: cx + (wx - view.centerX) * view.zoom,
    y: cy + (wy - view.centerY) * view.zoom,
  }
}

// Screen coordinates to world coordinates
export function screenToWorld(
  sx: number,
  sy: number,
  view: ViewState,
  canvasWidth: number,
  canvasHeight: number
): { x: number; y: number } {
  const cx = canvasWidth / 2
  const cy = canvasHeight / 2
  return {
    x: view.centerX + (sx - cx) / view.zoom,
    y: view.centerY + (sy - cy) / view.zoom,
  }
}

// Get visible world bounds
export function getVisibleBounds(
  view: ViewState,
  canvasWidth: number,
  canvasHeight: number
): { minX: number; minY: number; maxX: number; maxY: number } {
  const halfW = canvasWidth / view.zoom / 2
  const halfH = canvasHeight / view.zoom / 2

  return {
    minX: Math.floor(view.centerX - halfW),
    minY: Math.floor(view.centerY - halfH),
    maxX: Math.ceil(view.centerX + halfW),
    maxY: Math.ceil(view.centerY + halfH),
  }
}
```

### 5.3 Hand-Drawn Rendering Utilities

Create `src/lib/hand-drawn.ts`:

```typescript
// Generate a wobbly line using quadratic bezier curves
export function drawWobblyLine(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  wobbleAmount: number = 2,
  seed: number = 0
): void {
  // Simple seeded random for consistent wobble per edge
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return (seed / 0x7fffffff) * 2 - 1 // -1 to 1
  }

  const dx = x2 - x1
  const dy = y2 - y1
  const length = Math.sqrt(dx * dx + dy * dy)

  // Perpendicular direction for wobble
  const px = -dy / length
  const py = dx / length

  // Control point at midpoint with wobble
  const midX = (x1 + x2) / 2 + px * wobbleAmount * random()
  const midY = (y1 + y2) / 2 + py * wobbleAmount * random()

  ctx.beginPath()
  ctx.moveTo(x1 + random() * 0.5, y1 + random() * 0.5)
  ctx.quadraticCurveTo(midX, midY, x2 + random() * 0.5, y2 + random() * 0.5)
  ctx.stroke()
}

// Draw a slightly irregular dot
export function drawWobblyDot(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  seed: number = 0
): void {
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return (seed / 0x7fffffff) * 2 - 1
  }

  ctx.beginPath()

  // Draw slightly irregular circle
  const points = 8
  for (let i = 0; i <= points; i++) {
    const angle = (i / points) * Math.PI * 2
    const r = radius * (1 + random() * 0.1)
    const px = x + Math.cos(angle) * r
    const py = y + Math.sin(angle) * r

    if (i === 0) {
      ctx.moveTo(px, py)
    } else {
      ctx.lineTo(px, py)
    }
  }

  ctx.closePath()
  ctx.fill()
}

// Draw a watercolor-style box fill
export function drawWatercolorFill(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  color: string,
  seed: number = 0
): void {
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }

  // Main fill with some transparency variation
  ctx.fillStyle = color

  // Draw multiple overlapping shapes for watercolor effect
  const layers = 3
  for (let layer = 0; layer < layers; layer++) {
    ctx.globalAlpha = 0.3 + random() * 0.2

    const inset = 1 + random() * 2
    const wobble = 1

    ctx.beginPath()
    ctx.moveTo(x + inset + random() * wobble, y + inset + random() * wobble)
    ctx.lineTo(
      x + size - inset + random() * wobble,
      y + inset + random() * wobble
    )
    ctx.lineTo(
      x + size - inset + random() * wobble,
      y + size - inset + random() * wobble
    )
    ctx.lineTo(
      x + inset + random() * wobble,
      y + size - inset + random() * wobble
    )
    ctx.closePath()
    ctx.fill()
  }

  ctx.globalAlpha = 1
}
```

### 5.4 Edge Renderer

Create `src/components/game/EdgeRenderer.ts`:

```typescript
import { GameState } from "../../lib/game-state"
import {
  edgeIdToCoords,
  coordsToEdgeId,
  W,
  H,
  EDGE_COUNT,
} from "../../lib/edge-math"
import { getTeamColor } from "../../lib/teams"
import { drawWobblyLine } from "../../lib/hand-drawn"
import { ViewState } from "../../hooks/useViewState"
import { worldToScreen, getVisibleBounds } from "../../lib/view-transform"

const UNPLACED_COLOR = "rgba(150, 150, 150, 0.3)"
const PENDING_COLOR = "rgba(100, 100, 100, 0.6)"

export function renderEdges(
  ctx: CanvasRenderingContext2D,
  gameState: GameState,
  view: ViewState,
  canvasWidth: number,
  canvasHeight: number,
  pendingEdgeId: number | null = null,
  hoveredEdgeId: number | null = null
): void {
  const bounds = getVisibleBounds(view, canvasWidth, canvasHeight)
  const gridSize = view.zoom // 1 world unit = zoom pixels

  // Only render if zoomed in enough to see edges
  if (gridSize < 5) return // Too zoomed out

  const lineWidth = Math.max(1, gridSize * 0.1)
  ctx.lineWidth = lineWidth
  ctx.lineCap = "round"

  // Render horizontal edges in visible range
  for (
    let y = Math.max(0, bounds.minY);
    y <= Math.min(H, bounds.maxY + 1);
    y++
  ) {
    for (
      let x = Math.max(0, bounds.minX);
      x < Math.min(W, bounds.maxX + 1);
      x++
    ) {
      const edgeId = coordsToEdgeId(x, y, true)
      renderEdge(
        ctx,
        edgeId,
        x,
        y,
        true,
        gameState,
        view,
        canvasWidth,
        canvasHeight,
        pendingEdgeId,
        hoveredEdgeId,
        lineWidth
      )
    }
  }

  // Render vertical edges in visible range
  for (
    let y = Math.max(0, bounds.minY);
    y < Math.min(H, bounds.maxY + 1);
    y++
  ) {
    for (
      let x = Math.max(0, bounds.minX);
      x <= Math.min(W, bounds.maxX + 1);
      x++
    ) {
      const edgeId = coordsToEdgeId(x, y, false)
      renderEdge(
        ctx,
        edgeId,
        x,
        y,
        false,
        gameState,
        view,
        canvasWidth,
        canvasHeight,
        pendingEdgeId,
        hoveredEdgeId,
        lineWidth
      )
    }
  }
}

function renderEdge(
  ctx: CanvasRenderingContext2D,
  edgeId: number,
  x: number,
  y: number,
  horizontal: boolean,
  gameState: GameState,
  view: ViewState,
  canvasWidth: number,
  canvasHeight: number,
  pendingEdgeId: number | null,
  hoveredEdgeId: number | null,
  lineWidth: number
): void {
  let x1: number, y1: number, x2: number, y2: number

  if (horizontal) {
    // Horizontal edge from (x, y) to (x+1, y)
    const start = worldToScreen(x, y, view, canvasWidth, canvasHeight)
    const end = worldToScreen(x + 1, y, view, canvasWidth, canvasHeight)
    x1 = start.x
    y1 = start.y
    x2 = end.x
    y2 = end.y
  } else {
    // Vertical edge from (x, y) to (x, y+1)
    const start = worldToScreen(x, y, view, canvasWidth, canvasHeight)
    const end = worldToScreen(x, y + 1, view, canvasWidth, canvasHeight)
    x1 = start.x
    y1 = start.y
    x2 = end.x
    y2 = end.y
  }

  const isTaken = gameState.isEdgeTaken(edgeId)
  const isPending = edgeId === pendingEdgeId
  const isHovered = edgeId === hoveredEdgeId

  if (isTaken) {
    // Find team from stream (we'd need to track this - simplify for now)
    // For demo, use edge ID to determine team color
    const teamId = edgeId % 4 // Placeholder - should come from game state
    const color = getTeamColor(teamId)
    ctx.strokeStyle = color.primary
    ctx.lineWidth = lineWidth * 1.2
  } else if (isPending) {
    ctx.strokeStyle = PENDING_COLOR
    ctx.lineWidth = lineWidth * 1.5
    ctx.setLineDash([4, 4])
  } else if (isHovered) {
    ctx.strokeStyle = "rgba(0, 0, 0, 0.5)"
    ctx.lineWidth = lineWidth * 1.3
  } else {
    ctx.strokeStyle = UNPLACED_COLOR
    ctx.lineWidth = lineWidth * 0.5
    ctx.setLineDash([2, 4])
  }

  // Draw with hand-drawn style
  drawWobblyLine(ctx, x1, y1, x2, y2, lineWidth * 0.5, edgeId)

  ctx.setLineDash([])
}
```

### 5.5 Box Renderer

Create `src/components/game/BoxRenderer.ts`:

```typescript
import { GameState } from "../../lib/game-state"
import { boxIdToCoords, W, H, BOX_COUNT } from "../../lib/edge-math"
import { getTeamColor } from "../../lib/teams"
import { drawWatercolorFill } from "../../lib/hand-drawn"
import { ViewState } from "../../hooks/useViewState"
import { worldToScreen, getVisibleBounds } from "../../lib/view-transform"

export function renderBoxes(
  ctx: CanvasRenderingContext2D,
  gameState: GameState,
  view: ViewState,
  canvasWidth: number,
  canvasHeight: number
): void {
  const bounds = getVisibleBounds(view, canvasWidth, canvasHeight)
  const boxSize = view.zoom

  // Iterate over visible boxes
  for (let y = Math.max(0, bounds.minY); y < Math.min(H, bounds.maxY); y++) {
    for (let x = Math.max(0, bounds.minX); x < Math.min(W, bounds.maxX); x++) {
      const boxId = y * W + x
      const owner = gameState.getBoxOwner(boxId)

      if (owner > 0) {
        const teamId = owner - 1
        const color = getTeamColor(teamId)
        const screenPos = worldToScreen(x, y, view, canvasWidth, canvasHeight)

        drawWatercolorFill(
          ctx,
          screenPos.x,
          screenPos.y,
          boxSize,
          color.fill,
          boxId // Use boxId as seed for consistent rendering
        )
      }
    }
  }
}
```

### 5.6 Dot Renderer

Create `src/components/game/DotRenderer.ts`:

```typescript
import { W, H } from "../../lib/edge-math"
import { drawWobblyDot } from "../../lib/hand-drawn"
import { ViewState } from "../../hooks/useViewState"
import { worldToScreen, getVisibleBounds } from "../../lib/view-transform"

const DOT_COLOR = "#2D2D2D"

export function renderDots(
  ctx: CanvasRenderingContext2D,
  view: ViewState,
  canvasWidth: number,
  canvasHeight: number
): void {
  const bounds = getVisibleBounds(view, canvasWidth, canvasHeight)
  const dotRadius = Math.max(2, view.zoom * 0.15)

  // Only render if zoomed in enough
  if (view.zoom < 3) return

  ctx.fillStyle = DOT_COLOR

  // Render dots at grid intersections
  for (
    let y = Math.max(0, bounds.minY);
    y <= Math.min(H, bounds.maxY + 1);
    y++
  ) {
    for (
      let x = Math.max(0, bounds.minX);
      x <= Math.min(W, bounds.maxX + 1);
      x++
    ) {
      const screenPos = worldToScreen(x, y, view, canvasWidth, canvasHeight)
      drawWobblyDot(ctx, screenPos.x, screenPos.y, dotRadius, x * 1000 + y)
    }
  }
}
```

### 5.7 Main GameCanvas Component

Update `src/components/game/GameCanvas.tsx`:

```tsx
import { useRef, useEffect, useCallback, useState } from "react"
import { useViewState } from "../../hooks/useViewState"
import { useGameState } from "../../hooks/useGameState"
import { usePanZoom } from "../../hooks/usePanZoom"
import { renderBoxes } from "./BoxRenderer"
import { renderEdges } from "./EdgeRenderer"
import { renderDots } from "./DotRenderer"
import { screenToWorld } from "../../lib/view-transform"
import { findNearestEdge } from "../../lib/edge-picker"
import "./GameCanvas.css"

export function GameCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const { view, pan, zoomTo, zoomIn, zoomOut } = useViewState()
  const { gameState, pendingEdge, placeEdge } = useGameState()
  const [hoveredEdge, setHoveredEdge] = useState<number | null>(null)
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 })

  // Handle resize
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const observer = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect
      setCanvasSize({ width, height })
    })

    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  // Set up pan/zoom handlers
  usePanZoom(containerRef, {
    onPan: pan,
    onZoom: zoomTo,
  })

  // Render loop
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || canvasSize.width === 0) return

    const ctx = canvas.getContext("2d")
    if (!ctx) return

    // Set canvas size (account for device pixel ratio)
    const dpr = window.devicePixelRatio || 1
    canvas.width = canvasSize.width * dpr
    canvas.height = canvasSize.height * dpr
    ctx.scale(dpr, dpr)

    // Clear
    ctx.fillStyle = "#F5F5DC"
    ctx.fillRect(0, 0, canvasSize.width, canvasSize.height)

    // Render layers
    renderBoxes(ctx, gameState, view, canvasSize.width, canvasSize.height)
    renderEdges(
      ctx,
      gameState,
      view,
      canvasSize.width,
      canvasSize.height,
      pendingEdge,
      hoveredEdge
    )
    renderDots(ctx, view, canvasSize.width, canvasSize.height)
  }, [gameState, view, canvasSize, pendingEdge, hoveredEdge])

  // Handle mouse move for edge hover
  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!canvasRef.current) return

      const rect = canvasRef.current.getBoundingClientRect()
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top

      const worldPos = screenToWorld(
        x,
        y,
        view,
        canvasSize.width,
        canvasSize.height
      )
      const edgeId = findNearestEdge(worldPos.x, worldPos.y, view.zoom)

      setHoveredEdge(edgeId)
    },
    [view, canvasSize]
  )

  // Handle click to place edge
  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      if (hoveredEdge !== null) {
        placeEdge(hoveredEdge)
      }
    },
    [hoveredEdge, placeEdge]
  )

  return (
    <div ref={containerRef} className="game-canvas-container">
      <canvas
        ref={canvasRef}
        className="game-canvas"
        data-testid="game-canvas"
        style={{ width: canvasSize.width, height: canvasSize.height }}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHoveredEdge(null)}
        onClick={handleClick}
      />
    </div>
  )
}
```

### 5.8 Edge Picker Utility

Create `src/lib/edge-picker.ts`:

```typescript
import { coordsToEdgeId, W, H, HORIZ_COUNT } from "./edge-math"

// Find the nearest edge to a world coordinate
export function findNearestEdge(
  worldX: number,
  worldY: number,
  zoom: number
): number | null {
  // Only pick edges if zoomed in enough
  if (zoom < 5) return null

  const hitRadius = 0.3 // In world units

  // Check horizontal edges
  const nearestHorizY = Math.round(worldY)
  const nearestHorizX = Math.floor(worldX)

  if (
    nearestHorizX >= 0 &&
    nearestHorizX < W &&
    nearestHorizY >= 0 &&
    nearestHorizY <= H &&
    Math.abs(worldY - nearestHorizY) < hitRadius &&
    worldX - nearestHorizX > hitRadius &&
    nearestHorizX + 1 - worldX > hitRadius
  ) {
    return coordsToEdgeId(nearestHorizX, nearestHorizY, true)
  }

  // Check vertical edges
  const nearestVertX = Math.round(worldX)
  const nearestVertY = Math.floor(worldY)

  if (
    nearestVertX >= 0 &&
    nearestVertX <= W &&
    nearestVertY >= 0 &&
    nearestVertY < H &&
    Math.abs(worldX - nearestVertX) < hitRadius &&
    worldY - nearestVertY > hitRadius &&
    nearestVertY + 1 - worldY > hitRadius
  ) {
    return coordsToEdgeId(nearestVertX, nearestVertY, false)
  }

  return null
}
```

### 5.9 CSS for Canvas

Create `src/components/game/GameCanvas.css`:

```css
.game-canvas-container {
  width: 100%;
  height: 100%;
  overflow: hidden;
  touch-action: none; /* Prevent browser handling of touch gestures */
  cursor: crosshair;
}

.game-canvas {
  display: block;
}
```

## Deliverables

- [ ] `src/hooks/useViewState.ts` — Pan/zoom state management
- [ ] `src/lib/view-transform.ts` — Coordinate transforms
- [ ] `src/lib/hand-drawn.ts` — Wobbly line/dot/fill drawing
- [ ] `src/lib/edge-picker.ts` — Edge hit detection
- [ ] `src/components/game/EdgeRenderer.ts` — Edge rendering
- [ ] `src/components/game/BoxRenderer.ts` — Box fill rendering
- [ ] `src/components/game/DotRenderer.ts` — Dot rendering
- [ ] `src/components/game/GameCanvas.tsx` — Main canvas component
- [ ] Canvas renders with pan/zoom
- [ ] Hand-drawn visual style visible
- [ ] Edge hover/click detection works

## Next Phase

→ `06-ui-components.md`
