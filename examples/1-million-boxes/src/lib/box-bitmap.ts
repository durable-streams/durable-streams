import { GRID_HEIGHT, GRID_WIDTH } from "./config"

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

// Background color for unclaimed boxes
const BG_COLOR = { r: 245, g: 245, b: 220 } // Beige to match main canvas

/**
 * BoxBitmap maintains a 1000x1000 pixel ImageData buffer where each pixel
 * represents one box in the game. This provides:
 *
 * 1. Incremental updates - only changed pixels are updated
 * 2. Shared rendering source - used by both minimap and main canvas
 * 3. Efficient scaling - canvas drawImage handles GPU-accelerated scaling
 */
export class BoxBitmap {
  private imageData: ImageData
  private offscreenCanvas: OffscreenCanvas | HTMLCanvasElement
  private ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D

  constructor() {
    // Create ImageData at full game resolution (1px per box)
    this.imageData = new ImageData(GRID_WIDTH, GRID_HEIGHT)

    // Fill with background color
    const data = this.imageData.data
    for (let i = 0; i < GRID_WIDTH * GRID_HEIGHT; i++) {
      const idx = i * 4
      data[idx] = BG_COLOR.r
      data[idx + 1] = BG_COLOR.g
      data[idx + 2] = BG_COLOR.b
      data[idx + 3] = 255
    }

    // Create offscreen canvas for efficient drawImage operations
    if (typeof OffscreenCanvas !== `undefined`) {
      this.offscreenCanvas = new OffscreenCanvas(GRID_WIDTH, GRID_HEIGHT)
      this.ctx = this.offscreenCanvas.getContext(`2d`)!
    } else {
      // Fallback for browsers without OffscreenCanvas
      this.offscreenCanvas = document.createElement(`canvas`)
      this.offscreenCanvas.width = GRID_WIDTH
      this.offscreenCanvas.height = GRID_HEIGHT
      this.ctx = this.offscreenCanvas.getContext(`2d`)!
    }

    // Put initial image data
    this.ctx.putImageData(this.imageData, 0, 0)
  }

  /**
   * Update a single box pixel. Called when a box is claimed.
   * @param boxId The box ID (0 to 999,999)
   * @param teamId The team ID (0-3) that claimed the box
   */
  updateBox(boxId: number, teamId: number): void {
    const color = TEAM_COLORS_RGB[teamId]
    const idx = boxId * 4
    const data = this.imageData.data

    data[idx] = color.r
    data[idx + 1] = color.g
    data[idx + 2] = color.b
    // Alpha is already 255
  }

  /**
   * Batch update multiple boxes at once.
   * More efficient than calling updateBox repeatedly.
   */
  updateBoxes(boxes: Array<{ boxId: number; teamId: number }>): void {
    const data = this.imageData.data

    for (const { boxId, teamId } of boxes) {
      const color = TEAM_COLORS_RGB[teamId]
      const idx = boxId * 4
      data[idx] = color.r
      data[idx + 1] = color.g
      data[idx + 2] = color.b
    }
  }

  /**
   * Commit pending changes to the offscreen canvas.
   * Call this after a batch of updateBox/updateBoxes calls.
   */
  commit(): void {
    this.ctx.putImageData(this.imageData, 0, 0)
  }

  /**
   * Rebuild the entire bitmap from a GameState.
   * Used on initial load or when replaying events.
   */
  rebuildFromState(gameState: {
    getBoxOwner: (boxId: number) => number
  }): void {
    const data = this.imageData.data
    const totalBoxes = GRID_WIDTH * GRID_HEIGHT

    for (let boxId = 0; boxId < totalBoxes; boxId++) {
      const owner = gameState.getBoxOwner(boxId)
      const idx = boxId * 4

      if (owner > 0) {
        const color = TEAM_COLORS_RGB[owner - 1]
        data[idx] = color.r
        data[idx + 1] = color.g
        data[idx + 2] = color.b
      } else {
        data[idx] = BG_COLOR.r
        data[idx + 1] = BG_COLOR.g
        data[idx + 2] = BG_COLOR.b
      }
      data[idx + 3] = 255
    }

    this.commit()
  }

  /**
   * Get the canvas source for drawing.
   * Use this with ctx.drawImage() for efficient scaled rendering.
   */
  getCanvas(): OffscreenCanvas | HTMLCanvasElement {
    return this.offscreenCanvas
  }

  /**
   * Get the raw ImageData for direct pixel access.
   */
  getImageData(): ImageData {
    return this.imageData
  }

  /**
   * Draw the full bitmap to a destination canvas, scaled to fit.
   * @param destCtx Destination canvas context
   * @param destX Destination X position
   * @param destY Destination Y position
   * @param destWidth Destination width
   * @param destHeight Destination height
   * @param smooth Whether to use image smoothing (true for minimap, depends on zoom for main)
   */
  drawScaled(
    destCtx: CanvasRenderingContext2D,
    destX: number,
    destY: number,
    destWidth: number,
    destHeight: number,
    smooth: boolean = true
  ): void {
    destCtx.imageSmoothingEnabled = smooth
    destCtx.imageSmoothingQuality = smooth ? `high` : `low`
    destCtx.drawImage(
      this.offscreenCanvas,
      0,
      0,
      GRID_WIDTH,
      GRID_HEIGHT,
      destX,
      destY,
      destWidth,
      destHeight
    )
  }

  /**
   * Draw a portion of the bitmap to a destination canvas.
   * Used for main canvas viewport rendering.
   * @param destCtx Destination canvas context
   * @param srcX Source X in world/box coordinates
   * @param srcY Source Y in world/box coordinates
   * @param srcWidth Source width in world/box coordinates
   * @param srcHeight Source height in world/box coordinates
   * @param destX Destination X position
   * @param destY Destination Y position
   * @param destWidth Destination width
   * @param destHeight Destination height
   * @param smooth Whether to use image smoothing
   */
  drawViewport(
    destCtx: CanvasRenderingContext2D,
    srcX: number,
    srcY: number,
    srcWidth: number,
    srcHeight: number,
    destX: number,
    destY: number,
    destWidth: number,
    destHeight: number,
    smooth: boolean = true
  ): void {
    // Clamp source coordinates to valid range
    const clampedSrcX = Math.max(0, Math.min(GRID_WIDTH, srcX))
    const clampedSrcY = Math.max(0, Math.min(GRID_HEIGHT, srcY))
    const clampedSrcWidth = Math.min(srcWidth, GRID_WIDTH - clampedSrcX)
    const clampedSrcHeight = Math.min(srcHeight, GRID_HEIGHT - clampedSrcY)

    if (clampedSrcWidth <= 0 || clampedSrcHeight <= 0) return

    // Adjust destination if source was clamped
    const offsetX = ((clampedSrcX - srcX) / srcWidth) * destWidth
    const offsetY = ((clampedSrcY - srcY) / srcHeight) * destHeight
    const adjustedDestWidth = (clampedSrcWidth / srcWidth) * destWidth
    const adjustedDestHeight = (clampedSrcHeight / srcHeight) * destHeight

    destCtx.imageSmoothingEnabled = smooth
    destCtx.imageSmoothingQuality = smooth ? `high` : `low`
    destCtx.drawImage(
      this.offscreenCanvas,
      clampedSrcX,
      clampedSrcY,
      clampedSrcWidth,
      clampedSrcHeight,
      destX + offsetX,
      destY + offsetY,
      adjustedDestWidth,
      adjustedDestHeight
    )
  }
}
