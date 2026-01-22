import { H, W, boxIdToCoords } from "../../lib/edge-math"
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

/**
 * MinimapRenderer handles efficient pixel-based rendering of the minimap.
 * Uses ImageData for direct pixel manipulation for best performance.
 */
export class MinimapRenderer {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private size: number
  private dpr: number
  private imageData: ImageData

  constructor(canvas: HTMLCanvasElement, size: number) {
    this.canvas = canvas
    this.size = size
    this.dpr = window.devicePixelRatio || 1

    // Set up canvas with retina support
    this.canvas.width = size * this.dpr
    this.canvas.height = size * this.dpr
    this.canvas.style.width = `${size}px`
    this.canvas.style.height = `${size}px`

    const ctx = canvas.getContext(`2d`, { willReadFrequently: true })
    if (!ctx) {
      throw new Error(`Failed to get 2D context`)
    }
    this.ctx = ctx
    this.ctx.scale(this.dpr, this.dpr)

    // Create ImageData for pixel manipulation
    this.imageData = this.ctx.createImageData(size, size)
  }

  /**
   * Clear the minimap with a dark background.
   */
  clear(): void {
    const data = this.imageData.data

    // Dark background (rgba 30, 30, 30, 255)
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 30 // R
      data[i + 1] = 30 // G
      data[i + 2] = 30 // B
      data[i + 3] = 255 // A
    }
  }

  /**
   * Update a single box pixel on the minimap.
   * Maps from the 1000x1000 grid to the minimap size.
   */
  updateBox(boxId: number, teamId: number): void {
    const coords = boxIdToCoords(boxId)
    const color = TEAM_COLORS_RGB[teamId]

    // Map world coordinates to minimap coordinates
    const minimapX = Math.floor((coords.x / W) * this.size)
    const minimapY = Math.floor((coords.y / H) * this.size)

    // Clamp to valid range
    if (minimapX < 0 || minimapX >= this.size) return
    if (minimapY < 0 || minimapY >= this.size) return

    // Calculate pixel index in ImageData
    const pixelIndex = (minimapY * this.size + minimapX) * 4

    // Set pixel color
    this.imageData.data[pixelIndex] = color.r
    this.imageData.data[pixelIndex + 1] = color.g
    this.imageData.data[pixelIndex + 2] = color.b
    this.imageData.data[pixelIndex + 3] = 255
  }

  /**
   * Render all claimed boxes from the game state.
   */
  renderFull(gameState: GameState): void {
    this.clear()

    // Iterate over all boxes and render claimed ones
    const totalBoxes = W * H

    for (let boxId = 0; boxId < totalBoxes; boxId++) {
      const owner = gameState.getBoxOwner(boxId)
      if (owner > 0) {
        const teamId = owner - 1
        this.updateBox(boxId, teamId)
      }
    }
  }

  /**
   * Put the ImageData to the canvas.
   */
  render(): void {
    // Reset transform and put image data at 1:1 scale
    this.ctx.setTransform(1, 0, 0, 1, 0, 0)
    this.ctx.putImageData(this.imageData, 0, 0)

    // Restore scale for subsequent drawing (viewport rectangle)
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
  }

  /**
   * Draw the viewport rectangle showing the current view.
   */
  drawViewport(
    view: ViewState,
    canvasWidth: number,
    canvasHeight: number
  ): void {
    // Calculate visible world bounds
    const halfW = canvasWidth / view.zoom / 2
    const halfH = canvasHeight / view.zoom / 2

    const worldMinX = view.centerX - halfW
    const worldMinY = view.centerY - halfH
    const worldMaxX = view.centerX + halfW
    const worldMaxY = view.centerY + halfH

    // Convert to minimap coordinates
    const scale = this.size / W
    const rectX = worldMinX * scale
    const rectY = worldMinY * scale
    const rectW = (worldMaxX - worldMinX) * scale
    const rectH = (worldMaxY - worldMinY) * scale

    // Draw viewport rectangle
    this.ctx.strokeStyle = `white`
    this.ctx.lineWidth = 2
    this.ctx.strokeRect(rectX, rectY, rectW, rectH)
  }
}
