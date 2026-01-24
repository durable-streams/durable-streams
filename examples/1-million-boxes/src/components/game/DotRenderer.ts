import { getScale } from "../../lib/view-transform"
import { renderDotPattern } from "./DotPatternCache"
import type { ViewState } from "../../hooks/useViewState"

/**
 * Render all visible dots (grid intersection points) on the canvas.
 * Uses a cached tiled pattern for performance.
 * Only renders when zoomed in enough (scale >= 15 pixels per grid cell).
 */
export function renderDots(
  ctx: CanvasRenderingContext2D,
  view: ViewState,
  canvasWidth: number,
  canvasHeight: number
): void {
  const scale = getScale(view)

  // Render dots using cached tiled pattern
  renderDotPattern(
    ctx,
    scale,
    view.centerX,
    view.centerY,
    canvasWidth,
    canvasHeight
  )
}
