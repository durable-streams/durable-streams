/**
 * Shared game configuration used by both frontend and worker.
 *
 * This is the SINGLE SOURCE OF TRUTH for game-related constants.
 * Both src/lib/config.ts and worker/lib/config.ts import from here.
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
export const GAME_END_MODE: GameEndMode = `board_complete`

/**
 * Target score for "first_to_score" mode.
 * Game ends when any team reaches this number of boxes.
 * Only used when GAME_END_MODE is "first_to_score".
 */
export const FIRST_TO_SCORE_TARGET = 1000

// =============================================================================
// Game Grid Configuration
// =============================================================================

/**
 * Grid dimensions (number of boxes in each direction).
 * Total boxes = W * H = 1,000,000
 */
export const GRID_WIDTH = 1000
export const GRID_HEIGHT = 1000

/**
 * Total number of horizontal edges: W * (H + 1)
 */
export const HORIZ_EDGE_COUNT = GRID_WIDTH * (GRID_HEIGHT + 1)

/**
 * Total number of vertical edges: H * (W + 1)
 */
export const VERT_EDGE_COUNT = GRID_HEIGHT * (GRID_WIDTH + 1)

/**
 * Total number of edges in the game.
 */
export const TOTAL_EDGE_COUNT = HORIZ_EDGE_COUNT + VERT_EDGE_COUNT

/**
 * Total number of boxes in the game.
 */
export const TOTAL_BOX_COUNT = GRID_WIDTH * GRID_HEIGHT

// =============================================================================
// Stream Configuration
// =============================================================================

/**
 * The stream path for the game events.
 */
export const GAME_STREAM_PATH = `/game0`

// =============================================================================
// Quota Configuration (Shared: Server + Client)
// =============================================================================
//
// HOW QUOTA WORKS:
// - Each player has a token bucket with MAX_QUOTA tokens (default: 8)
// - Drawing a line costs 1 token
// - Tokens refill at a rate of 1 per QUOTA_REFILL_INTERVAL_MS (default: 6s)
// - BONUS: Completing a box grants bonus tokens!
//   - Complete 1 box: get QUOTA_BONUS_SINGLE tokens back (refund + bonus)
//   - Complete 2 boxes with one line: get QUOTA_BONUS_DOUBLE tokens back
//   This mimics the "extra turn" mechanic from classic Dots & Boxes.
// - The server (Durable Object) is authoritative; client tracks optimistically
//   for instant UI feedback, then syncs with server response.
//
// =============================================================================

/**
 * Maximum number of tokens (lines) a player can have.
 */
export const MAX_QUOTA = 8

/**
 * Time interval for refilling one quota token (in ms).
 * At 3000ms, a player gets 1 token every 3 seconds.
 */
export const QUOTA_REFILL_INTERVAL_MS = 3000

/**
 * Bonus tokens granted for completing 1 box with a single move.
 * This includes the refund for the move spent plus a bonus.
 */
export const QUOTA_BONUS_SINGLE = 2

/**
 * Bonus tokens granted for completing 2 boxes with a single move.
 * This includes the refund for the move spent plus a bonus.
 */
export const QUOTA_BONUS_DOUBLE = 4

/**
 * Timing leeway in ms for quota consumption (server-side).
 * Allows moves if a refill would happen within this window.
 * Accounts for client/server clock differences and network latency.
 */
export const QUOTA_TIMING_LEEWAY_MS = 500

/**
 * Time in ms after which inactive players are garbage collected (server-side).
 * Players who haven't made a move in this time have their quota data removed.
 */
export const QUOTA_GC_INACTIVE_MS = 10 * 60 * 1000 // 10 minutes

/**
 * LocalStorage key for persisting quota state (client-side optimistic UI).
 */
export const QUOTA_STORAGE_KEY = `boxes:quota`

/**
 * LocalStorage key for storing the game start timestamp.
 * Used to detect game resets and clear stale client data.
 */
export const GAME_START_TIMESTAMP_KEY = `boxes:game-start`
