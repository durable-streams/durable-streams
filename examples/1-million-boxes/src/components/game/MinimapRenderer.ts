import { H, W } from "../../lib/edge-math"
import { DOT_SPACING } from "../../lib/config"
import type { ViewState } from "../../hooks/useViewState"
import type { GameState } from "../../lib/game-state"

/**
 * RGB color values for each team.
 * Matches the primary colors from teams.ts but in RGB format.
 */
const TEAM_COLORS_RGB: Array<{ r: number; g: number; b: number }> = [
  { r: 229, g: 57, b: 53 }, // RED: #E53935
  { r: 30, g: 136, b: 229 }, // BLUE: #1E88E5
  { r: 67, g: 160, b: 71 }, // GREEN: #43A047
  { r: 253, g: 216, b: 53 }, // YELLOW: #FDD835
]

// Background color for unclaimed areas
const BG_COLOR = { r: 245, g: 245, b: 220 } // Beige to match main canvas

/**
 * MinimapRenderer handles efficient pixel-based rendering of the minimap.
 * Each pixel represents the average color of all boxes it covers.
 */
export class MinimapRenderer {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private size: number

  constructor(canvas: HTMLCanvasElement, size: number) {
    this.canvas = canvas
    this.size = size

    // Set up canvas (no retina scaling - we want exact pixel control)
    this.canvas.width = size
    this.canvas.height = size
    this.canvas.style.width = `${size}px`
    this.canvas.style.height = `${size}px`

    const ctx = canvas.getContext(`2d`, { willReadFrequently: true })
    if (!ctx) {
      throw new Error(`Failed to get 2D context`)
    }
    this.ctx = ctx

    // Disable image smoothing for crisp pixels
    this.ctx.imageSmoothingEnabled = false
  }

  /**
   * Render all boxes from the game state with color averaging.
   * Each minimap pixel represents multiple boxes, so we average their colors.
   */
  renderFull(gameState: GameState): void {
    const imageData = this.ctx.createImageData(this.size, this.size)
    const data = imageData.data

    // Calculate how many boxes each minimap pixel covers
    const boxesPerPixelX = W / this.size
    const boxesPerPixelY = H / this.size

    // For each minimap pixel
    for (let my = 0; my < this.size; my++) {
      for (let mx = 0; mx < this.size; mx++) {
        // Calculate the range of boxes this pixel covers
        const boxMinX = Math.floor(mx * boxesPerPixelX)
        const boxMaxX = Math.floor((mx + 1) * boxesPerPixelX)
        const boxMinY = Math.floor(my * boxesPerPixelY)
        const boxMaxY = Math.floor((my + 1) * boxesPerPixelY)

        // Count team ownership for boxes in this pixel
        const teamCounts = [0, 0, 0, 0]
        let totalClaimed = 0
        let totalBoxes = 0

        for (let by = boxMinY; by < boxMaxY; by++) {
          for (let bx = boxMinX; bx < boxMaxX; bx++) {
            const boxId = by * W + bx
            const owner = gameState.getBoxOwner(boxId)
            totalBoxes++

            if (owner > 0) {
              teamCounts[owner - 1]++
              totalClaimed++
            }
          }
        }

        // Calculate average color
        let r = 0,
          g = 0,
          b = 0

        if (totalClaimed > 0) {
          // Blend team colors based on their counts
          for (let t = 0; t < 4; t++) {
            if (teamCounts[t] > 0) {
              const weight = teamCounts[t] / totalClaimed
              r += TEAM_COLORS_RGB[t].r * weight
              g += TEAM_COLORS_RGB[t].g * weight
              b += TEAM_COLORS_RGB[t].b * weight
            }
          }

          // Blend with background based on claim ratio
          const claimRatio = totalClaimed / totalBoxes
          r = r * claimRatio + BG_COLOR.r * (1 - claimRatio)
          g = g * claimRatio + BG_COLOR.g * (1 - claimRatio)
          b = b * claimRatio + BG_COLOR.b * (1 - claimRatio)
        } else {
          // All unclaimed - use background color
          r = BG_COLOR.r
          g = BG_COLOR.g
          b = BG_COLOR.b
        }

        // Set pixel color
        const pixelIndex = (my * this.size + mx) * 4
        data[pixelIndex] = Math.round(r)
        data[pixelIndex + 1] = Math.round(g)
        data[pixelIndex + 2] = Math.round(b)
        data[pixelIndex + 3] = 255
      }
    }

    // Put the image data to canvas
    this.ctx.putImageData(imageData, 0, 0)
  }

  /**
   * Compatibility method - just calls renderFull.
   */
  render(): void {
    // No-op - renderFull already puts the image data
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
