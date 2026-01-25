import { W } from "../../../shared/edge-math"
import { DOT_SPACING } from "../../lib/config"
import type { ViewState } from "../../hooks/useViewState"
import type { BoxBitmap } from "../../lib/box-bitmap"

/**
 * MinimapRenderer handles rendering the minimap using a shared BoxBitmap.
 * The BoxBitmap provides the 1px-per-box game state, which we scale down
 * to fit the minimap canvas.
 */
export class MinimapRenderer {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private size: number

  constructor(canvas: HTMLCanvasElement, size: number) {
    this.canvas = canvas
    this.size = size

    // Set internal canvas resolution (CSS controls display size)
    this.canvas.width = size
    this.canvas.height = size

    const ctx = canvas.getContext(`2d`)
    if (!ctx) {
      throw new Error(`Failed to get 2D context`)
    }
    this.ctx = ctx
  }

  /**
   * Render the minimap using the shared BoxBitmap.
   * The bitmap is scaled down to fit the minimap size with smooth interpolation.
   */
  render(boxBitmap: BoxBitmap): void {
    // Clear and draw the bitmap scaled to minimap size
    this.ctx.clearRect(0, 0, this.size, this.size)
    boxBitmap.drawScaled(this.ctx, 0, 0, this.size, this.size, true)
  }

  /**
   * Draw the viewport rectangle showing the current view.
   */
  drawViewport(
    view: ViewState,
    canvasWidth: number,
    canvasHeight: number
  ): void {
    // Calculate visible world bounds using scale (pixels per grid cell)
    const viewScale = view.zoom * DOT_SPACING
    const halfW = canvasWidth / viewScale / 2
    const halfH = canvasHeight / viewScale / 2

    const worldMinX = view.centerX - halfW
    const worldMinY = view.centerY - halfH
    const worldMaxX = view.centerX + halfW
    const worldMaxY = view.centerY + halfH

    // Convert to minimap coordinates
    const minimapScale = this.size / W
    const rectX = worldMinX * minimapScale
    const rectY = worldMinY * minimapScale
    const rectW = (worldMaxX - worldMinX) * minimapScale
    const rectH = (worldMaxY - worldMinY) * minimapScale

    // Draw viewport rectangle
    this.ctx.strokeStyle = `rgba(0, 0, 0, 0.8)`
    this.ctx.lineWidth = 2
    this.ctx.strokeRect(rectX, rectY, rectW, rectH)

    // Draw inner white line for contrast
    this.ctx.strokeStyle = `rgba(255, 255, 255, 0.8)`
    this.ctx.lineWidth = 1
    this.ctx.strokeRect(rectX + 1, rectY + 1, rectW - 2, rectH - 2)
  }
}
