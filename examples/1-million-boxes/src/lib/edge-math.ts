import {
  GRID_HEIGHT,
  GRID_WIDTH,
  HORIZ_EDGE_COUNT,
  TOTAL_BOX_COUNT,
  TOTAL_EDGE_COUNT,
  VERT_EDGE_COUNT,
} from "./config"

// Re-export grid dimensions with short aliases for use in this module
export const W = GRID_WIDTH
export const H = GRID_HEIGHT

// Re-export edge/box counts
export const HORIZ_COUNT = HORIZ_EDGE_COUNT
export const VERT_COUNT = VERT_EDGE_COUNT
export const EDGE_COUNT = TOTAL_EDGE_COUNT
export const BOX_COUNT = TOTAL_BOX_COUNT

// Types
export interface EdgeCoords {
  x: number
  y: number
  horizontal: boolean
}

export interface BoxCoords {
  x: number
  y: number
}

/**
 * Convert an edge ID to its coordinates and orientation.
 *
 * Horizontal edges: edgeId = y*W + x (y from 0 to H, x from 0 to W-1)
 * Vertical edges: edgeId = HORIZ_COUNT + y*(W+1) + x (y from 0 to H-1, x from 0 to W)
 */
export function edgeIdToCoords(edgeId: number): EdgeCoords {
  if (edgeId < HORIZ_COUNT) {
    // Horizontal edge
    const y = Math.floor(edgeId / W)
    const x = edgeId % W
    return { x, y, horizontal: true }
  } else {
    // Vertical edge
    const idx = edgeId - HORIZ_COUNT
    const y = Math.floor(idx / (W + 1))
    const x = idx % (W + 1)
    return { x, y, horizontal: false }
  }
}

/**
 * Convert coordinates and orientation to an edge ID.
 */
export function coordsToEdgeId(
  x: number,
  y: number,
  horizontal: boolean
): number {
  if (horizontal) {
    return y * W + x
  } else {
    return HORIZ_COUNT + y * (W + 1) + x
  }
}

/**
 * Check if an edge ID represents a horizontal edge.
 */
export function isHorizontal(edgeId: number): boolean {
  return edgeId < HORIZ_COUNT
}

/**
 * Get the boxes adjacent to an edge.
 *
 * - Horizontal edge at (x, y) borders boxes at (x, y-1) and (x, y)
 * - Vertical edge at (x, y) borders boxes at (x-1, y) and (x, y)
 *
 * Returns 0-2 boxes depending on whether the edge is on a boundary.
 */
export function getAdjacentBoxes(edgeId: number): Array<BoxCoords> {
  const boxes: Array<BoxCoords> = []
  const coords = edgeIdToCoords(edgeId)

  if (coords.horizontal) {
    // Horizontal edge at (x, y) borders boxes at (x, y-1) and (x, y)
    if (coords.y > 0) {
      boxes.push({ x: coords.x, y: coords.y - 1 })
    }
    if (coords.y < H) {
      boxes.push({ x: coords.x, y: coords.y })
    }
  } else {
    // Vertical edge at (x, y) borders boxes at (x-1, y) and (x, y)
    if (coords.x > 0) {
      boxes.push({ x: coords.x - 1, y: coords.y })
    }
    if (coords.x < W) {
      boxes.push({ x: coords.x, y: coords.y })
    }
  }

  return boxes
}

/**
 * Get the four edge IDs surrounding a box at (x, y).
 * Returns [top, bottom, left, right] edge IDs.
 */
export function getBoxEdges(
  x: number,
  y: number
): [number, number, number, number] {
  const top = y * W + x // h(x, y)
  const bottom = (y + 1) * W + x // h(x, y+1)
  const left = HORIZ_COUNT + y * (W + 1) + x // v(x, y)
  const right = HORIZ_COUNT + y * (W + 1) + (x + 1) // v(x+1, y)
  return [top, bottom, left, right]
}

/**
 * Convert box coordinates to a box ID.
 */
export function boxCoordsToId(x: number, y: number): number {
  return y * W + x
}

/**
 * Convert a box ID to box coordinates.
 */
export function boxIdToCoords(boxId: number): BoxCoords {
  return {
    x: boxId % W,
    y: Math.floor(boxId / W),
  }
}

/**
 * Check if an edge ID is valid.
 */
export function isValidEdgeId(edgeId: number): boolean {
  return Number.isInteger(edgeId) && edgeId >= 0 && edgeId < EDGE_COUNT
}
