/**
 * Configuration constants for the worker.
 * These match the values in src/lib/config.ts.
 */

// =============================================================================
// Game End Conditions
// =============================================================================

/**
 * Game end mode:
 * - "board_complete": Game ends when all boxes are claimed, leader wins
 * - "first_to_score": Game ends when a team reaches the target score
 */
export type GameEndMode = `board_complete` | `first_to_score`

/**
 * Current game end mode.
 * Change this to test different end conditions.
 */
export const GAME_END_MODE: GameEndMode = `first_to_score`

/**
 * Target score for "first_to_score" mode.
 * Game ends when any team reaches this number of boxes.
 * Only used when GAME_END_MODE is "first_to_score".
 */
export const FIRST_TO_SCORE_TARGET = 5

// =============================================================================
// Grid Configuration
// =============================================================================

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
