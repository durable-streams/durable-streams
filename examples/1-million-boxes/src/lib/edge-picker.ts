import { H, W, coordsToEdgeId } from "./edge-math"

/**
 * Detect if the current device supports touch
 */
export function isTouchDevice(): boolean {
  return (
    `ontouchstart` in window ||
    navigator.maxTouchPoints > 0 ||
    // @ts-expect-error msMaxTouchPoints is IE-specific
    navigator.msMaxTouchPoints > 0
  )
}

/**
 * Find the nearest edge to a world coordinate.
 * Returns the edge ID if one is close enough, or null otherwise.
 *
 * Only picks edges if zoomed in enough.
 * Touch devices have a larger hit radius and lower minimum zoom requirement.
 *
 * @param worldX - X coordinate in world space
 * @param worldY - Y coordinate in world space
 * @param zoom - Current zoom level
 * @param isTouch - Whether this is a touch interaction (defaults to isTouchDevice())
 */
export function findNearestEdge(
  worldX: number,
  worldY: number,
  zoom: number,
  isTouch?: boolean
): number | null {
  // Default to device detection if not specified
  const touchMode = isTouch ?? isTouchDevice()

  // Touch devices need lower zoom threshold for easier selection
  const minZoom = touchMode ? 3 : 5
  if (zoom < minZoom) return null

  // Larger hit radius for touch to accommodate finger imprecision
  const hitRadius = touchMode ? 0.4 : 0.25

  // Check horizontal edges first
  // Horizontal edge at (x, y) spans from point (x, y) to (x+1, y)
  const nearestHorizY = Math.round(worldY)
  const nearestHorizX = Math.floor(worldX)

  // Check if we're close to a horizontal edge
  if (
    nearestHorizX >= 0 &&
    nearestHorizX < W &&
    nearestHorizY >= 0 &&
    nearestHorizY <= H
  ) {
    const distToHorizEdge = Math.abs(worldY - nearestHorizY)
    const alongEdge = worldX - nearestHorizX

    // Must be close to the edge line and not too close to endpoints
    if (
      distToHorizEdge < hitRadius &&
      alongEdge > hitRadius &&
      alongEdge < 1 - hitRadius
    ) {
      return coordsToEdgeId(nearestHorizX, nearestHorizY, true)
    }
  }

  // Check vertical edges
  // Vertical edge at (x, y) spans from point (x, y) to (x, y+1)
  const nearestVertX = Math.round(worldX)
  const nearestVertY = Math.floor(worldY)

  if (
    nearestVertX >= 0 &&
    nearestVertX <= W &&
    nearestVertY >= 0 &&
    nearestVertY < H
  ) {
    const distToVertEdge = Math.abs(worldX - nearestVertX)
    const alongEdge = worldY - nearestVertY

    // Must be close to the edge line and not too close to endpoints
    if (
      distToVertEdge < hitRadius &&
      alongEdge > hitRadius &&
      alongEdge < 1 - hitRadius
    ) {
      return coordsToEdgeId(nearestVertX, nearestVertY, false)
    }
  }

  return null
}
