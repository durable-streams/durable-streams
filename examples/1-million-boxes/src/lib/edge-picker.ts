import { H, W, coordsToEdgeId } from "./edge-math"

/**
 * Find the nearest edge to a world coordinate.
 * Returns the edge ID if one is close enough, or null otherwise.
 *
 * Only picks edges if zoomed in enough (zoom >= 5).
 */
export function findNearestEdge(
  worldX: number,
  worldY: number,
  zoom: number
): number | null {
  // Only pick edges if zoomed in enough
  if (zoom < 5) return null

  // Hit radius in world units - smaller when zoomed in more
  const hitRadius = 0.3

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
