import { H, W } from "../../lib/edge-math"
import { getTeamColor } from "../../lib/teams"
import { drawWatercolorFill } from "../../lib/hand-drawn"
import { getVisibleBounds, worldToScreen } from "../../lib/view-transform"
import type { ViewState } from "../../hooks/useViewState"
import type { GameState } from "../../lib/game-state"

/**
 * Render all visible claimed boxes on the canvas.
 */
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
