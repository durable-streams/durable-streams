import { H, W, coordsToEdgeId } from "../../lib/edge-math"
import { getTeamColor } from "../../lib/teams"
import { drawWobblyLine } from "../../lib/hand-drawn"
import {
  getScale,
  getVisibleBounds,
  worldToScreen,
} from "../../lib/view-transform"
import { HOVERED_EDGE_COLOR } from "../../lib/config"
import type { ViewState } from "../../hooks/useViewState"
import type { GameState } from "../../lib/game-state"

const UNPLACED_COLOR = `rgba(150, 150, 150, 0.3)`
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
  hoveredEdgeId: number | null = null
): void {
  const bounds = getVisibleBounds(view, canvasWidth, canvasHeight)
  const gridSize = getScale(view) // pixels per grid cell

  // Only render if zoomed in enough to see edges
  if (gridSize < 5) return

  const lineWidth = Math.max(1, gridSize * 0.1)
  ctx.lineCap = `round`

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

  // Reset line dash
  ctx.setLineDash([])

  if (isTaken) {
    // For taken edges, we use a placeholder color based on edgeId
    // In the real implementation, edge ownership would come from game state
    const teamId = edgeId % 4 // Placeholder - should come from actual edge data
    const color = getTeamColor(teamId)
    ctx.strokeStyle = color.primary
    ctx.lineWidth = lineWidth * 1.2
  } else if (isPending) {
    ctx.strokeStyle = PENDING_COLOR
    ctx.lineWidth = lineWidth * 1.5
    ctx.setLineDash([4, 4])
  } else if (isHovered) {
    ctx.strokeStyle = HOVERED_EDGE_COLOR
    ctx.lineWidth = lineWidth * 1.3
  } else {
    ctx.strokeStyle = UNPLACED_COLOR
    ctx.lineWidth = lineWidth * 0.5
    ctx.setLineDash([2, 4])
  }

  // Draw with hand-drawn style
  drawWobblyLine(ctx, x1, y1, x2, y2, lineWidth * 0.5, edgeId)

  // Reset line dash after drawing
  ctx.setLineDash([])
}
