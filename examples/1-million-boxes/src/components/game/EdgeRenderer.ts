import { H, W, coordsToEdgeId } from "../../lib/edge-math"
import { getTeamColor } from "../../lib/teams"
import {
  getScale,
  getVisibleBounds,
  worldToScreen,
} from "../../lib/view-transform"
import { HOVERED_EDGE_COLOR } from "../../lib/config"
import { renderGridPattern } from "./GridPatternCache"
import type { ViewState } from "../../hooks/useViewState"
import type { GameState } from "../../lib/game-state"

const PENDING_COLOR = `rgba(100, 100, 100, 0.6)`

// Threshold below which we use straight lines with wobbled endpoints (faster)
// Above this, we use full quadratic curves
const CURVE_THRESHOLD = 15

// Threshold below which we disable endpoint wobble entirely (fastest)
const WOBBLE_THRESHOLD = 8

/**
 * Simple seeded random for deterministic wobble
 */
function seededRandom(seed: number): number {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff
  return (seed / 0x7fffffff) * 2 - 1 // -1 to 1
}

/**
 * Get second seeded random value
 */
function seededRandom2(seed: number): number {
  return seededRandom(seed * 127 + 31)
}

/**
 * Edge data for batched rendering
 */
interface EdgeSegment {
  x1: number
  y1: number
  x2: number
  y2: number
  edgeId: number
}

/**
 * Batched edges grouped by color
 */
interface EdgeBatch {
  color: string
  lineWidth: number
  dashed: boolean
  edges: Array<EdgeSegment>
}

/**
 * Render all visible edges on the canvas.
 */
export function renderEdges(
  ctx: CanvasRenderingContext2D,
  gameState: GameState,
  view: ViewState,
  canvasWidth: number,
  canvasHeight: number,
  pendingEdgeId: number | null = null,
  hoveredEdgeId: number | null = null,
  renderGridLines: boolean = true,
  renderDrawnLines: boolean = true,
  bounds?: { minX: number; minY: number; maxX: number; maxY: number }
): void {
  // Early exit if nothing to render
  if (!renderGridLines && !renderDrawnLines) return

  const gridSize = getScale(view) // pixels per grid cell

  // Only render if zoomed in enough to see edges
  if (gridSize < 2) return

  // Render grid lines using cached tiled pattern (much faster than individual lines)
  if (renderGridLines) {
    renderGridPattern(
      ctx,
      gridSize,
      view.centerX,
      view.centerY,
      canvasWidth,
      canvasHeight
    )
  }

  // Only iterate edges if we need to render taken/pending/hovered edges
  if (!renderDrawnLines && pendingEdgeId === null && hoveredEdgeId === null) {
    return
  }

  const visibleBounds =
    bounds ?? getVisibleBounds(view, canvasWidth, canvasHeight)
  // Line width scales with grid size, with a minimum of 0.5px for very small sizes
  const lineWidth = Math.max(0.5, gridSize * 0.1)

  // Batches for color grouping: Map<colorKey, EdgeBatch>
  // colorKey format: "color|lineWidthMultiplier|dashed"
  const batches = new Map<string, EdgeBatch>()

  // Helper to add edge to batch
  const addToBatch = (
    color: string,
    lineWidthMult: number,
    dashed: boolean,
    segment: EdgeSegment
  ) => {
    const key = `${color}|${lineWidthMult}|${dashed}`
    let batch = batches.get(key)
    if (!batch) {
      batch = {
        color,
        lineWidth: lineWidth * lineWidthMult,
        dashed,
        edges: [],
      }
      batches.set(key, batch)
    }
    batch.edges.push(segment)
  }

  // Collect horizontal edges in visible range
  for (
    let y = Math.max(0, visibleBounds.minY);
    y <= Math.min(H, visibleBounds.maxY + 1);
    y++
  ) {
    for (
      let x = Math.max(0, visibleBounds.minX);
      x < Math.min(W, visibleBounds.maxX + 1);
      x++
    ) {
      const edgeId = coordsToEdgeId(x, y, true)
      collectEdge(
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
        renderDrawnLines,
        addToBatch
      )
    }
  }

  // Collect vertical edges in visible range
  for (
    let y = Math.max(0, visibleBounds.minY);
    y < Math.min(H, visibleBounds.maxY + 1);
    y++
  ) {
    for (
      let x = Math.max(0, visibleBounds.minX);
      x <= Math.min(W, visibleBounds.maxX + 1);
      x++
    ) {
      const edgeId = coordsToEdgeId(x, y, false)
      collectEdge(
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
        renderDrawnLines,
        addToBatch
      )
    }
  }

  // Render all batches
  ctx.lineCap = `round`
  const useCurves = gridSize >= CURVE_THRESHOLD
  const useWobble = gridSize >= WOBBLE_THRESHOLD
  const wobbleAmount = lineWidth * 0.5

  for (const batch of batches.values()) {
    renderBatch(ctx, batch, useCurves, useWobble, wobbleAmount)
  }
}

/**
 * Collect edge into appropriate batch if it's a special edge (taken, pending, or hovered).
 * Grid lines are handled by the tiled pattern.
 */
function collectEdge(
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
  renderDrawnLines: boolean,
  addToBatch: (
    color: string,
    lineWidthMult: number,
    dashed: boolean,
    segment: EdgeSegment
  ) => void
): void {
  const isTaken = gameState.isEdgeTaken(edgeId)
  const isPending = edgeId === pendingEdgeId
  const isHovered = edgeId === hoveredEdgeId

  // Skip unplaced edges (handled by tiled pattern)
  if (!isTaken && !isPending && !isHovered) return

  // Skip taken edges if debug flag is off
  if (isTaken && !renderDrawnLines) return

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

  const segment: EdgeSegment = { x1, y1, x2, y2, edgeId }

  if (isTaken) {
    const teamId = gameState.getEdgeOwner(edgeId) ?? 0
    const color = getTeamColor(teamId).primary
    addToBatch(color, 1.2, false, segment)
  } else if (isPending) {
    addToBatch(PENDING_COLOR, 1.5, true, segment)
  } else if (isHovered) {
    addToBatch(HOVERED_EDGE_COLOR, 1.3, false, segment)
  }
}

/**
 * Render a batch of edges with the same style.
 * Uses a single Path2D and stroke() call for all edges in the batch.
 */
function renderBatch(
  ctx: CanvasRenderingContext2D,
  batch: EdgeBatch,
  useCurves: boolean,
  useWobble: boolean,
  wobbleAmount: number
): void {
  if (batch.edges.length === 0) return

  ctx.strokeStyle = batch.color
  ctx.lineWidth = batch.lineWidth
  ctx.setLineDash(batch.dashed ? [4, 4] : [])

  const path = new Path2D()

  for (const edge of batch.edges) {
    const { x1, y1, x2, y2, edgeId } = edge

    if (useWobble) {
      // Deterministic wobble based on edge ID
      const r1 = seededRandom(edgeId)
      const r2 = seededRandom2(edgeId)
      const r3 = seededRandom(edgeId + 1000)
      const r4 = seededRandom2(edgeId + 1000)

      // Wobbled start and end points
      const startX = x1 + r1 * 0.5
      const startY = y1 + r2 * 0.5
      const endX = x2 + r3 * 0.5
      const endY = y2 + r4 * 0.5

      path.moveTo(startX, startY)

      if (useCurves) {
        // Full quadratic curve for zoomed in view
        const dx = x2 - x1
        const dy = y2 - y1
        const length = Math.sqrt(dx * dx + dy * dy)

        if (length > 0.001) {
          // Perpendicular direction for midpoint wobble
          const px = -dy / length
          const py = dx / length
          const midX = (x1 + x2) / 2 + px * wobbleAmount * r1
          const midY = (y1 + y2) / 2 + py * wobbleAmount * r2

          path.quadraticCurveTo(midX, midY, endX, endY)
        } else {
          path.lineTo(endX, endY)
        }
      } else {
        // Straight line with wobbled endpoints
        path.lineTo(endX, endY)
      }
    } else {
      // No wobble - pure straight lines (fastest)
      path.moveTo(x1, y1)
      path.lineTo(x2, y2)
    }
  }

  ctx.stroke(path)
}
