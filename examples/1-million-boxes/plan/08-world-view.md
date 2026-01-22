# Phase 08: World View (Minimap)

## Goal

Implement the minimap showing the entire game board with claimed boxes and a viewport indicator. Clicking the minimap should navigate to that location.

## Dependencies

- Phase 05 (Canvas Rendering)
- Phase 07 (Real-time Sync)

## Tasks

### 8.1 WorldView Component

Update `src/components/game/WorldView.tsx`:

```tsx
import { useRef, useEffect, useCallback } from "react"
import { useGameStateContext } from "../../contexts/game-state-context"
import { useViewState } from "../../hooks/useViewState"
import { W, H } from "../../lib/edge-math"
import { getTeamColor } from "../../lib/teams"
import "./WorldView.css"

const MINIMAP_SIZE = 150
const SCALE = MINIMAP_SIZE / W // 0.15

export function WorldView() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const { gameState } = useGameStateContext()
  const { view, jumpTo } = useViewState()

  // Render minimap
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext("2d")
    if (!ctx) return

    // Set canvas size for retina
    const dpr = window.devicePixelRatio || 1
    canvas.width = MINIMAP_SIZE * dpr
    canvas.height = MINIMAP_SIZE * dpr
    ctx.scale(dpr, dpr)

    // Clear with dark background
    ctx.fillStyle = "rgba(0, 0, 0, 0.85)"
    ctx.fillRect(0, 0, MINIMAP_SIZE, MINIMAP_SIZE)

    // Draw claimed boxes using ImageData for performance
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
    const data = imageData.data

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const boxId = y * W + x
        const owner = gameState.getBoxOwner(boxId)

        if (owner > 0) {
          const teamId = owner - 1
          const color = getTeamColor(teamId)

          // Convert hex to RGB
          const rgb = hexToRgb(color.primary)

          // Calculate pixel position (accounting for DPR)
          const px = Math.floor(x * SCALE * dpr)
          const py = Math.floor(y * SCALE * dpr)

          // Set pixel color
          const idx = (py * canvas.width + px) * 4
          data[idx] = rgb.r
          data[idx + 1] = rgb.g
          data[idx + 2] = rgb.b
          data[idx + 3] = 255
        }
      }
    }

    ctx.putImageData(imageData, 0, 0)

    // Draw viewport rectangle
    drawViewportRect(ctx, view)
  }, [gameState, view])

  // Handle click to navigate
  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current
      if (!canvas) return

      const rect = canvas.getBoundingClientRect()
      const x = (e.clientX - rect.left) / SCALE
      const y = (e.clientY - rect.top) / SCALE

      jumpTo(x, y)
    },
    [jumpTo]
  )

  return (
    <div className="world-view" data-testid="world-view">
      <canvas
        ref={canvasRef}
        className="world-view-canvas"
        style={{ width: MINIMAP_SIZE, height: MINIMAP_SIZE }}
        onClick={handleClick}
      />
    </div>
  )
}

function drawViewportRect(
  ctx: CanvasRenderingContext2D,
  view: { centerX: number; centerY: number; zoom: number }
) {
  // Calculate visible bounds
  // Assuming a typical viewport of 800x600 for estimation
  const viewportWidth = 800
  const viewportHeight = 600

  const halfW = viewportWidth / view.zoom / 2
  const halfH = viewportHeight / view.zoom / 2

  const left = (view.centerX - halfW) * SCALE
  const top = (view.centerY - halfH) * SCALE
  const width = halfW * 2 * SCALE
  const height = halfH * 2 * SCALE

  // Clamp to minimap bounds
  const clampedLeft = Math.max(0, left)
  const clampedTop = Math.max(0, top)
  const clampedRight = Math.min(MINIMAP_SIZE, left + width)
  const clampedBottom = Math.min(MINIMAP_SIZE, top + height)
  const clampedWidth = clampedRight - clampedLeft
  const clampedHeight = clampedBottom - clampedTop

  // Draw rectangle
  ctx.strokeStyle = "white"
  ctx.lineWidth = 2
  ctx.strokeRect(clampedLeft, clampedTop, clampedWidth, clampedHeight)

  // Draw corner indicators
  ctx.fillStyle = "white"
  const cornerSize = 4

  // Top-left
  ctx.fillRect(clampedLeft - 1, clampedTop - 1, cornerSize, 2)
  ctx.fillRect(clampedLeft - 1, clampedTop - 1, 2, cornerSize)

  // Top-right
  ctx.fillRect(clampedRight - cornerSize + 1, clampedTop - 1, cornerSize, 2)
  ctx.fillRect(clampedRight - 1, clampedTop - 1, 2, cornerSize)

  // Bottom-left
  ctx.fillRect(clampedLeft - 1, clampedBottom - 1, cornerSize, 2)
  ctx.fillRect(clampedLeft - 1, clampedBottom - cornerSize + 1, 2, cornerSize)

  // Bottom-right
  ctx.fillRect(clampedRight - cornerSize + 1, clampedBottom - 1, cornerSize, 2)
  ctx.fillRect(clampedRight - 1, clampedBottom - cornerSize + 1, 2, cornerSize)
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  return result
    ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16),
      }
    : { r: 0, g: 0, b: 0 }
}
```

### 8.2 WorldView CSS

Create `src/components/game/WorldView.css`:

```css
.world-view {
  position: absolute;
  bottom: var(--minimap-margin);
  right: var(--minimap-margin);
  border-radius: 8px;
  overflow: hidden;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  border: 2px solid rgba(255, 255, 255, 0.8);
  cursor: pointer;
  transition:
    transform 0.2s,
    box-shadow 0.2s;
}

.world-view:hover {
  transform: scale(1.02);
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.4);
}

.world-view-canvas {
  display: block;
}

/* Responsive minimap size */
@media (max-width: 640px) {
  .world-view {
    --minimap-size: 100px;
    bottom: calc(var(--footer-height) + 8px);
    right: 8px;
  }
}
```

### 8.3 Optimized Minimap Rendering

For better performance with large games, create an optimized renderer:

Create `src/components/game/MinimapRenderer.ts`:

```typescript
import { GameState } from "../../lib/game-state"
import { W, H } from "../../lib/edge-math"
import { getTeamColor } from "../../lib/teams"

const TEAM_COLORS_RGB = [
  { r: 229, g: 57, b: 53 }, // RED
  { r: 30, g: 136, b: 229 }, // BLUE
  { r: 67, g: 160, b: 71 }, // GREEN
  { r: 253, g: 216, b: 53 }, // YELLOW
]

export class MinimapRenderer {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private imageData: ImageData
  private size: number
  private dpr: number
  private dirty = true
  private lastVersion = -1

  constructor(canvas: HTMLCanvasElement, size: number) {
    this.canvas = canvas
    this.size = size
    this.dpr = window.devicePixelRatio || 1

    canvas.width = size * this.dpr
    canvas.height = size * this.dpr

    this.ctx = canvas.getContext("2d")!
    this.ctx.scale(this.dpr, this.dpr)

    this.imageData = this.ctx.createImageData(canvas.width, canvas.height)

    // Initialize with dark background
    this.clear()
  }

  clear(): void {
    const data = this.imageData.data
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 20 // R
      data[i + 1] = 20 // G
      data[i + 2] = 20 // B
      data[i + 3] = 220 // A
    }
  }

  // Incrementally update only changed boxes
  updateBox(boxId: number, teamId: number): void {
    const x = boxId % W
    const y = Math.floor(boxId / W)

    const scale = (this.size * this.dpr) / W
    const px = Math.floor(x * scale)
    const py = Math.floor(y * scale)

    const color = TEAM_COLORS_RGB[teamId]
    const idx = (py * this.canvas.width + px) * 4

    this.imageData.data[idx] = color.r
    this.imageData.data[idx + 1] = color.g
    this.imageData.data[idx + 2] = color.b
    this.imageData.data[idx + 3] = 255

    this.dirty = true
  }

  // Full render from game state
  renderFull(gameState: GameState): void {
    this.clear()

    const scale = (this.size * this.dpr) / W
    const data = this.imageData.data

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const boxId = y * W + x
        const owner = gameState.getBoxOwner(boxId)

        if (owner > 0) {
          const teamId = owner - 1
          const color = TEAM_COLORS_RGB[teamId]

          const px = Math.floor(x * scale)
          const py = Math.floor(y * scale)
          const idx = (py * this.canvas.width + px) * 4

          data[idx] = color.r
          data[idx + 1] = color.g
          data[idx + 2] = color.b
          data[idx + 3] = 255
        }
      }
    }

    this.dirty = true
  }

  render(): void {
    if (!this.dirty) return

    this.ctx.putImageData(this.imageData, 0, 0)
    this.dirty = false
  }

  // Draw viewport indicator (call after render)
  drawViewport(
    view: { centerX: number; centerY: number; zoom: number },
    canvasWidth: number,
    canvasHeight: number
  ): void {
    const scale = this.size / W

    const halfW = canvasWidth / view.zoom / 2
    const halfH = canvasHeight / view.zoom / 2

    const left = (view.centerX - halfW) * scale
    const top = (view.centerY - halfH) * scale
    const width = halfW * 2 * scale
    const height = halfH * 2 * scale

    // Clamp
    const x = Math.max(0, Math.min(this.size - 4, left))
    const y = Math.max(0, Math.min(this.size - 4, top))
    const w = Math.min(this.size - x, Math.max(4, width))
    const h = Math.min(this.size - y, Math.max(4, height))

    this.ctx.strokeStyle = "white"
    this.ctx.lineWidth = 2
    this.ctx.strokeRect(x, y, w, h)
  }
}
```

### 8.4 Use Optimized Renderer in WorldView

Update `WorldView.tsx` to use the optimized renderer:

```tsx
import { useRef, useEffect, useCallback } from "react"
import { useGameStateContext } from "../../contexts/game-state-context"
import { useViewState, ViewStateContext } from "../../hooks/useViewState"
import { W } from "../../lib/edge-math"
import { MinimapRenderer } from "./MinimapRenderer"
import "./WorldView.css"

const MINIMAP_SIZE = 150
const SCALE = MINIMAP_SIZE / W

export function WorldView() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rendererRef = useRef<MinimapRenderer | null>(null)
  const { gameState } = useGameStateContext()
  const { view, jumpTo, canvasSize } = useViewState()

  // Initialize renderer
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    rendererRef.current = new MinimapRenderer(canvas, MINIMAP_SIZE)
  }, [])

  // Update on game state changes
  useEffect(() => {
    const renderer = rendererRef.current
    if (!renderer) return

    renderer.renderFull(gameState)
    renderer.render()
    renderer.drawViewport(view, canvasSize.width, canvasSize.height)
  }, [gameState, view, canvasSize])

  // Handle click
  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current
      if (!canvas) return

      const rect = canvas.getBoundingClientRect()
      const x = (e.clientX - rect.left) / SCALE
      const y = (e.clientY - rect.top) / SCALE

      jumpTo(Math.round(x), Math.round(y))
    },
    [jumpTo]
  )

  return (
    <div className="world-view" data-testid="world-view">
      <canvas
        ref={canvasRef}
        className="world-view-canvas"
        style={{ width: MINIMAP_SIZE, height: MINIMAP_SIZE }}
        onClick={handleClick}
      />
    </div>
  )
}
```

## Deliverables

- [ ] `src/components/game/WorldView.tsx` — Minimap component
- [ ] `src/components/game/MinimapRenderer.ts` — Optimized renderer
- [ ] `src/components/game/WorldView.css` — Styling
- [ ] Minimap shows all claimed boxes
- [ ] Viewport rectangle shows current view
- [ ] Click navigation works
- [ ] Responsive sizing on mobile

## Next Phase

→ `09-mobile-support.md`
