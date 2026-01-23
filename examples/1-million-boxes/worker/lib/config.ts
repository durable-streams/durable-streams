/**
 * Configuration constants for the worker.
 *
 * Re-exports shared game configuration from shared/game-config.ts
 * to maintain a single source of truth.
 */

export {
  // Game end conditions
  type GameEndMode,
  GAME_END_MODE,
  FIRST_TO_SCORE_TARGET,
  // Grid configuration
  GRID_WIDTH,
  GRID_HEIGHT,
  HORIZ_EDGE_COUNT,
  VERT_EDGE_COUNT,
  TOTAL_EDGE_COUNT,
  TOTAL_BOX_COUNT,
  // Stream configuration
  GAME_STREAM_PATH,
} from "../../shared/game-config"
