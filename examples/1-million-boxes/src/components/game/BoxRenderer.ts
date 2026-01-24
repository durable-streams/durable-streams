import { H, W } from "../../lib/edge-math"
import { getTeamColor } from "../../lib/teams"
import { drawWatercolorFill } from "../../lib/hand-drawn"
import {
  getScale,
  getVisibleBounds,
  worldToScreen,
} from "../../lib/view-transform"
import type { ViewState } from "../../hooks/useViewState"
import type { GameState } from "../../lib/game-state"
import type { BoxBitmap } from "../../lib/box-bitmap"

/**
 * Threshold for switching between bitmap and hand-drawn rendering.
 * Below this size (in pixels per box), we use the bitmap approach.
 * Above this, we use the hand-drawn style.
 */
const BITMAP_THRESHOLD = 4

/**
 * Render all visible claimed boxes on the canvas.
 * Uses hybrid rendering:
 * - Bitmap mode (boxSize <= BITMAP_THRESHOLD): Draw from shared BoxBitmap with scaling
 * - Hand-drawn mode (boxSize > BITMAP_THRESHOLD): Draw individual boxes with watercolor effect
 */
export function renderBoxes(
  ctx: CanvasRenderingContext2D,
  gameState: GameState,
  view: ViewState,
  canvasWidth: number,
  canvasHeight: number,
  boxBitmap?: BoxBitmap
): void {
  const boxSize = getScale(view)

  // Use bitmap mode when zoomed out (boxes are small)
  if (boxBitmap && boxSize <= BITMAP_THRESHOLD) {
    renderBitmapMode(ctx, view, canvasWidth, canvasHeight, boxBitmap)
  } else {
    renderHandDrawnMode(ctx, gameState, view, canvasWidth, canvasHeight)
  }
}

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
}

/**
 * Hand-drawn rendering mode: Draw individual boxes with watercolor effect.
 * Used when zoomed in for nice visual quality.
 */
function renderHandDrawnMode(
  ctx: CanvasRenderingContext2D,
  gameState: GameState,
  view: ViewState,
  canvasWidth: number,
  canvasHeight: number
): void {
  const bounds = getVisibleBounds(view, canvasWidth, canvasHeight)
  const boxSize = getScale(view)

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
