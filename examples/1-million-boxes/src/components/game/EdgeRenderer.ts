import { H, W, coordsToEdgeId } from "../../lib/edge-math"
import { getTeamColor } from "../../lib/teams"
import { drawWobblyLine } from "../../lib/hand-drawn"
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
  renderDrawnLines: boolean = true
): void {
  // Early exit if nothing to render
  if (!renderGridLines && !renderDrawnLines) return

  const gridSize = getScale(view) // pixels per grid cell

  // Only render if zoomed in enough to see edges (matches BITMAP_THRESHOLD in BoxRenderer)
  if (gridSize < 4) return

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

  const bounds = getVisibleBounds(view, canvasWidth, canvasHeight)
  const lineWidth = Math.max(1, gridSize * 0.1)
  ctx.lineCap = `round`

  // Render horizontal edges in visible range (only taken/pending/hovered)
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
      renderSpecialEdge(
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
        lineWidth,
        renderDrawnLines
      )
    }
  }

  // Render vertical edges in visible range (only taken/pending/hovered)
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
      renderSpecialEdge(
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
        lineWidth,
        renderDrawnLines
      )
    }
  }
}

/**
 * Render only "special" edges: taken, pending, or hovered.
 * Grid lines are handled by the tiled pattern.
 */
function renderSpecialEdge(
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
  lineWidth: number,
  renderDrawnLines: boolean
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

  if (isTaken) {
    // Get the team that placed this edge
    const teamId = gameState.getEdgeOwner(edgeId) ?? 0
    const color = getTeamColor(teamId)
    ctx.strokeStyle = color.primary
    ctx.lineWidth = lineWidth * 1.2
    ctx.setLineDash([])
  } else if (isPending) {
    ctx.strokeStyle = PENDING_COLOR
    ctx.lineWidth = lineWidth * 1.5
    ctx.setLineDash([4, 4])
  } else if (isHovered) {
    ctx.strokeStyle = HOVERED_EDGE_COLOR
    ctx.lineWidth = lineWidth * 1.3
    ctx.setLineDash([])
  }

  // Draw with hand-drawn style
  drawWobblyLine(ctx, x1, y1, x2, y2, lineWidth * 0.5, edgeId)
}
