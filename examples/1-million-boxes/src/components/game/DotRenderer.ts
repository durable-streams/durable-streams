import { H, W } from "../../lib/edge-math"
import { drawWobblyDot } from "../../lib/hand-drawn"
import { getVisibleBounds, worldToScreen } from "../../lib/view-transform"
import type { ViewState } from "../../hooks/useViewState"

const DOT_COLOR = `#2D2D2D`

/**
 * Render all visible dots (grid intersection points) on the canvas.
 * Only renders when zoomed in enough (zoom >= 3).
 */
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
