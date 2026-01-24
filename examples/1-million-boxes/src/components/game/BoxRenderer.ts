import {
  getScale,
  getVisibleBounds,
  worldToScreen,
} from "../../lib/view-transform"
import type { ViewState } from "../../hooks/useViewState"
import type { GameState } from "../../lib/game-state"
import type { BoxBitmap } from "../../lib/box-bitmap"

/**
 * Render all visible claimed boxes on the canvas.
 * Always uses GPU-accelerated bitmap scaling for performance.
 * Nearest-neighbor scaling when zoomed in gives crisp pixel edges.
 */
export function renderBoxes(
  ctx: CanvasRenderingContext2D,
  _gameState: GameState,
  view: ViewState,
  canvasWidth: number,
  canvasHeight: number,
  boxBitmap?: BoxBitmap
): void {
  if (!boxBitmap) return

  renderBitmapMode(ctx, view, canvasWidth, canvasHeight, boxBitmap)
}

// Opacity for box fills - gives a softer, watercolor-like appearance
const BOX_FILL_OPACITY = 0.5
// Higher opacity when edges are not rendered (very zoomed out)
const BOX_FILL_OPACITY_NO_EDGES = 0.8
// Threshold below which edges are not rendered
const EDGE_RENDER_THRESHOLD = 2

/**
 * Bitmap rendering mode: Draw the visible portion of the BoxBitmap scaled to screen.
 * Uses different scaling modes based on box size:
 * - Boxes < 1px: Smooth scaling for proper color blending (many boxes → one pixel)
 * - Boxes >= 1px: Crisp nearest-neighbor scaling for sharp pixels
 */
function renderBitmapMode(
  ctx: CanvasRenderingContext2D,
  view: ViewState,
  canvasWidth: number,
  canvasHeight: number,
  boxBitmap: BoxBitmap
): void {
  const bounds = getVisibleBounds(view, canvasWidth, canvasHeight)
  const scale = getScale(view)

  // Calculate source rectangle (in world/box coordinates)
  const srcX = bounds.minX
  const srcY = bounds.minY
  const srcWidth = bounds.maxX - bounds.minX
  const srcHeight = bounds.maxY - bounds.minY

  // Calculate where this maps to on screen
  const topLeft = worldToScreen(
    bounds.minX,
    bounds.minY,
    view,
    canvasWidth,
    canvasHeight
  )

  // Use smooth scaling only when zoomed out (boxes < 1px)
  // When boxes are >= 1px, use crisp nearest-neighbor for sharp pixels
  const useSmooth = scale < 1

  // Apply transparency for softer, watercolor-like appearance
  // Use higher opacity when edges are not rendered (very zoomed out)
  const prevAlpha = ctx.globalAlpha
  ctx.globalAlpha =
    scale < EDGE_RENDER_THRESHOLD ? BOX_FILL_OPACITY_NO_EDGES : BOX_FILL_OPACITY

  // Draw the visible portion scaled to fit
  boxBitmap.drawViewport(
    ctx,
    srcX,
    srcY,
    srcWidth,
    srcHeight,
    topLeft.x,
    topLeft.y,
    srcWidth * scale,
    srcHeight * scale,
    useSmooth
  )

  // Restore alpha
  ctx.globalAlpha = prevAlpha
}
