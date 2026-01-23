/**
 * Configuration constants for the worker.
 * These match the values in src/lib/config.ts.
 */

// Grid dimensions
export const GRID_WIDTH = 1000
export const GRID_HEIGHT = 1000

// Edge counts
export const HORIZ_EDGE_COUNT = GRID_WIDTH * (GRID_HEIGHT + 1)
export const VERT_EDGE_COUNT = GRID_HEIGHT * (GRID_WIDTH + 1)
export const TOTAL_EDGE_COUNT = HORIZ_EDGE_COUNT + VERT_EDGE_COUNT
export const TOTAL_BOX_COUNT = GRID_WIDTH * GRID_HEIGHT

// Stream path
export const GAME_STREAM_PATH = `/game`
