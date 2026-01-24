/**
 * Cache for the tiled grid line pattern.
 * Pre-renders multi-cell tiles at different scale levels for crisp rendering.
 *
 * Using a larger tile (4x4 cells) provides more variation in the wobbly
 * edges before the pattern repeats, making it look more natural.
 */

import { drawWobblyLine } from "../../lib/hand-drawn"

// Solid color equivalent of rgba(150, 150, 150, 0.3) blended on #F5F5DC background
// Calculated: R/G = 150*0.3 + 245*0.7 = 217, B = 150*0.3 + 220*0.7 = 199
const UNPLACED_COLOR = `#D9D9C7`

// Tile covers multiple grid cells for more variation
const TILE_CELLS = 4

// Cache tiles at different cell sizes for crisp rendering at different zoom levels
interface CacheEntry {
  canvas: OffscreenCanvas
  lastUsed: number
}
const tileCache = new Map<number, CacheEntry>()

// Available cell sizes to cache (covers typical zoom range)
// We'll pick the closest one that's >= the target size (scale down, not up)
const CACHED_CELL_SIZES = [16, 32, 64, 128, 256]

// Dispose tiles not used within this time (in ms)
const CACHE_TTL = 5_000 // 5 seconds

// Cleanup interval
let cleanupTimer: ReturnType<typeof setInterval> | null = null

// Track the currently active tile size (never evict this one)
let currentTileSize: number | null = null

function startCleanupTimer(): void {
  if (cleanupTimer) return
  cleanupTimer = setInterval(() => {
    const now = Date.now()
    for (const [size, entry] of tileCache) {
      // Never evict the currently active tile
      if (size === currentTileSize) continue
      if (now - entry.lastUsed > CACHE_TTL) {
        tileCache.delete(size)
      }
    }
    // Stop timer if cache is empty
    if (tileCache.size === 0 && cleanupTimer) {
      clearInterval(cleanupTimer)
      cleanupTimer = null
    }
  }, 10_000) // Check every 10 seconds
}

/**
 * Get the best cached cell size for the given target size.
 * Returns the smallest cached size that's >= target (to scale down, not up).
 */
function getBestCellSize(targetSize: number): number {
  for (const size of CACHED_CELL_SIZES) {
    if (size >= targetSize) return size
  }
  // If target is larger than our biggest, use the biggest
  return CACHED_CELL_SIZES[CACHED_CELL_SIZES.length - 1]
}

/**
 * Create a tile canvas at the specified cell size.
 *
 * The tile origin is offset by half a cell, so the tile covers grid positions
 * from (-0.5, -0.5) to (TILE_CELLS - 0.5, TILE_CELLS - 0.5).
 * This means edges at integer grid positions (0, 1, 2, 3) are fully inside
 * the tile with their wobble, and tile seams fall at cell centers where
 * there's nothing to render.
 */
function createTile(cellSize: number): OffscreenCanvas | null {
  const tileSize = TILE_CELLS * cellSize
  const canvas = new OffscreenCanvas(tileSize, tileSize)
  const ctx = canvas.getContext(`2d`)
  if (!ctx) return null

  // Setup style for grid lines - minimum 0.5px for very small sizes
  const lineWidth = Math.max(0.5, cellSize * 0.1)
  ctx.strokeStyle = UNPLACED_COLOR
  ctx.lineWidth = lineWidth * 0.5
  ctx.lineCap = `round`
  ctx.setLineDash([2, 4])

  // Offset: tile position 0 = grid position -0.5
  // So grid position 0 = tile position 0.5 * cellSize
  const offset = cellSize / 2

  let seed = 0

  // Draw horizontal edges
  // Grid rows 0, 1, 2, 3 are at tile positions offset, offset+cellSize, etc.
  for (let row = 0; row < TILE_CELLS; row++) {
    const y = offset + row * cellSize
    for (let col = 0; col < TILE_CELLS; col++) {
      // Each edge spans one cell width
      const x1 = offset + col * cellSize - cellSize / 2
      const x2 = offset + col * cellSize + cellSize / 2
      drawWobblyLine(ctx, x1, y, x2, y, lineWidth * 0.5, seed++)
    }
  }

  // Draw vertical edges
  for (let col = 0; col < TILE_CELLS; col++) {
    const x = offset + col * cellSize
    for (let row = 0; row < TILE_CELLS; row++) {
      const y1 = offset + row * cellSize - cellSize / 2
      const y2 = offset + row * cellSize + cellSize / 2
      drawWobblyLine(ctx, x, y1, x, y2, lineWidth * 0.5, seed++)
    }
  }

  return canvas
}

/**
 * Get or create a cached tile at the appropriate size.
 */
function getTile(
  targetCellSize: number
): { canvas: OffscreenCanvas; cellSize: number } | null {
  const cellSize = getBestCellSize(targetCellSize)

  // Track current tile size so it's never evicted
  currentTileSize = cellSize

  let entry = tileCache.get(cellSize)
  if (entry) {
    // Update last used time
    entry.lastUsed = Date.now()
  } else {
    const canvas = createTile(cellSize)
    if (canvas) {
      entry = { canvas, lastUsed: Date.now() }
      tileCache.set(cellSize, entry)
      startCleanupTimer()
    }
  }

  if (!entry) return null
  return { canvas: entry.canvas, cellSize }
}

/**
 * Render the grid pattern across the visible area.
 * Uses pattern.setTransform() to scale the pattern to match the current grid size.
 */
export function renderGridPattern(
  ctx: CanvasRenderingContext2D,
  gridSize: number,
  viewCenterX: number,
  viewCenterY: number,
  canvasWidth: number,
  canvasHeight: number
): void {
  // Don't render grid at very small sizes
  if (gridSize < 2) return

  const tileData = getTile(gridSize)
  if (!tileData) return

  const { canvas, cellSize } = tileData

  const pattern = ctx.createPattern(canvas, `repeat`)
  if (!pattern) return

  // Calculate scale factor to make each cell in the tile match the current grid size
  // Since we pick a cellSize >= gridSize, this scale is usually <= 1 (scaling down)
  const scale = gridSize / cellSize

  // World (0,0) in screen coordinates
  const worldOriginX = canvasWidth / 2 - viewCenterX * gridSize
  const worldOriginY = canvasHeight / 2 - viewCenterY * gridSize

  // The tile is offset by half a cell (tile origin = grid position -0.5)
  // So we need to shift the pattern by -0.5 cells to align grid position 0
  // with tile position offset (which is cellSize/2)
  const tileOffset = cellSize / 2

  // Use pattern.setTransform to scale and position the pattern correctly
  // This transforms the pattern itself, not the fill coordinates
  const matrix = new DOMMatrix()
    .translate(worldOriginX, worldOriginY)
    .scale(scale, scale)
    .translate(-tileOffset, -tileOffset)

  pattern.setTransform(matrix)

  ctx.fillStyle = pattern
  ctx.fillRect(0, 0, canvasWidth, canvasHeight)
}

/**
 * Clear the tile cache (if needed for memory management).
 */
export function clearGridPatternCache(): void {
  tileCache.clear()
  if (cleanupTimer) {
    clearInterval(cleanupTimer)
    cleanupTimer = null
  }
}
