/**
 * Cache for the tiled dot pattern.
 * Pre-renders dots at grid intersections and uses ctx.createPattern() for efficient tiling.
 *
 * Using a larger tile (4x4 cells = 5x5 dots) provides variation before repeating.
 * Dots are offset by half a cell so tile seams fall at cell centers.
 */

import { GRID_HEIGHT, GRID_WIDTH } from "../../../shared/game-config"
import { drawWobblyDot } from "../../lib/hand-drawn"

const DOT_COLOR = `#2D2D2D`

// Tile covers multiple grid cells for variation (5x5 = 25 dots per tile)
const TILE_CELLS = 4

// Cache tiles at different cell sizes for crisp rendering at different zoom levels
interface CacheEntry {
  canvas: OffscreenCanvas
  lastUsed: number
}
const tileCache = new Map<number, CacheEntry>()

// Available cell sizes to cache (dots only render when scale >= 15)
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
  return CACHED_CELL_SIZES[CACHED_CELL_SIZES.length - 1]
}

/**
 * Create a dot tile canvas at the specified cell size.
 *
 * Dots are placed at grid intersections. The tile is offset by half a cell
 * so dots are fully inside the tile and seams fall at cell centers.
 */
function createTile(cellSize: number): OffscreenCanvas | null {
  const tileSize = TILE_CELLS * cellSize
  const canvas = new OffscreenCanvas(tileSize, tileSize)
  const ctx = canvas.getContext(`2d`)
  if (!ctx) return null

  const dotRadius = Math.max(2, cellSize * 0.15)
  ctx.fillStyle = DOT_COLOR

  // Offset: tile origin is at grid position (-0.5, -0.5)
  // So grid intersection (0,0) is at tile position (cellSize/2, cellSize/2)
  const offset = cellSize / 2

  let seed = 1000 // Different seed range from edges

  // Draw dots at grid intersections
  // For a TILE_CELLS x TILE_CELLS tile, we have (TILE_CELLS) x (TILE_CELLS) dots
  // (the +1 dots at the far edges will come from adjacent tiles)
  for (let row = 0; row < TILE_CELLS; row++) {
    for (let col = 0; col < TILE_CELLS; col++) {
      const x = offset + col * cellSize
      const y = offset + row * cellSize
      drawWobblyDot(ctx, x, y, dotRadius, seed++)
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
 * Render the dot pattern across the visible area.
 * Uses pattern.setTransform() to scale the pattern to match the current grid size.
 * Clips to the playable area boundaries to prevent overflow.
 */
export function renderDotPattern(
  ctx: CanvasRenderingContext2D,
  gridSize: number,
  viewCenterX: number,
  viewCenterY: number,
  canvasWidth: number,
  canvasHeight: number
): void {
  // Only render dots when zoomed in enough (matches original threshold)
  if (gridSize < 15) return

  const tileData = getTile(gridSize)
  if (!tileData) return

  const { canvas, cellSize } = tileData

  const pattern = ctx.createPattern(canvas, `repeat`)
  if (!pattern) return

  // Scale factor to match current grid size
  const scale = gridSize / cellSize

  // World (0,0) in screen coordinates
  const worldOriginX = canvasWidth / 2 - viewCenterX * gridSize
  const worldOriginY = canvasHeight / 2 - viewCenterY * gridSize

  // Offset for the half-cell shift
  const tileOffset = cellSize / 2

  const matrix = new DOMMatrix()
    .translate(worldOriginX, worldOriginY)
    .scale(scale, scale)
    .translate(-tileOffset, -tileOffset)

  pattern.setTransform(matrix)

  // Calculate the playable area bounds in screen coordinates
  // Dots exist at grid intersections from (0,0) to (W,H) in world coordinates
  // Expand bounds slightly to include full dots at edges (not just half)
  // Dot radius in screen pixels is approximately 0.15 * gridSize, add margin for wobble
  const dotMargin = 0.2 * gridSize
  const boundsMinX = worldOriginX - dotMargin
  const boundsMinY = worldOriginY - dotMargin
  const boundsMaxX = worldOriginX + GRID_WIDTH * gridSize + dotMargin
  const boundsMaxY = worldOriginY + GRID_HEIGHT * gridSize + dotMargin

  // Clip to visible canvas area
  const fillX = Math.max(0, boundsMinX)
  const fillY = Math.max(0, boundsMinY)
  const fillMaxX = Math.min(canvasWidth, boundsMaxX)
  const fillMaxY = Math.min(canvasHeight, boundsMaxY)
  const fillW = fillMaxX - fillX
  const fillH = fillMaxY - fillY

  // Only render if there's something visible
  if (fillW > 0 && fillH > 0) {
    ctx.fillStyle = pattern
    ctx.fillRect(fillX, fillY, fillW, fillH)
  }
}

/**
 * Clear the tile cache.
 */
export function clearDotPatternCache(): void {
  tileCache.clear()
  if (cleanupTimer) {
    clearInterval(cleanupTimer)
    cleanupTimer = null
  }
}
