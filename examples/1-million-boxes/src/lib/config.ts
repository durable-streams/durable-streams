/**
 * Centralized configuration for the 1 Million Boxes game.
 *
 * This file re-exports shared game configuration from shared/game-config.ts
 * and adds frontend-specific configuration values.
 */

// =============================================================================
// Re-export shared configuration (single source of truth)
// =============================================================================

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

// =============================================================================
// Frontend-specific Stream Configuration
// =============================================================================

/**
 * API endpoint for stream access through the worker proxy.
 * All stream connections go through the worker for proper SSE handling.
 */
export const STREAM_PROXY_ENDPOINT = `/api/stream/game`

/**
 * Delay before reconnecting after a stream connection error (in ms).
 */
export const STREAM_RECONNECT_DELAY_MS = 3000

// =============================================================================
// Zoom Configuration
// =============================================================================

/**
 * Minimum zoom level (fully zoomed out).
 * At 0.05 with DOT_SPACING=10, a box is 0.5px - barely visible but allows
 * seeing large portions of the grid.
 */
export const MIN_ZOOM = 0.05

/**
 * Maximum zoom level (fully zoomed in).
 * At 20 with DOT_SPACING=10, a box is 200px.
 */
export const MAX_ZOOM = 20

/**
 * Default zoom level on initial load.
 * At 2 with DOT_SPACING=10, a box is 20px - comfortable for interaction.
 */
export const DEFAULT_ZOOM = 2

/**
 * Zoom step for zoom in/out buttons (multiplier).
 */
export const ZOOM_STEP = 1.5

// =============================================================================
// Quota Configuration
// =============================================================================

/**
 * LocalStorage key for persisting quota state.
 */
export const QUOTA_STORAGE_KEY = `boxes:quota`

/**
 * Maximum number of lines a player can have stored.
 */
export const MAX_QUOTA = 8

/**
 * Time interval for refilling one quota unit (in ms).
 */
export const QUOTA_REFILL_INTERVAL_MS = 7500

// =============================================================================
// Rendering Configuration
// =============================================================================

/**
 * Visual spacing between grid dots in world coordinates.
 */
export const DOT_SPACING = 10

/**
 * Base radius for grid dots.
 */
export const DOT_RADIUS = 2

/**
 * Line width for placed edges.
 */
export const EDGE_LINE_WIDTH = 2

/**
 * Line width for hovered (preview) edges.
 */
export const HOVERED_EDGE_LINE_WIDTH = 3

/**
 * Color for hovered edge preview.
 */
export const HOVERED_EDGE_COLOR = `rgba(0, 0, 0, 0.5)`

/**
 * Minimum zoom level at which grid dots are visible.
 */
export const DOT_VISIBILITY_ZOOM = 0.3

// =============================================================================
// Touch/Mobile Configuration
// =============================================================================

/**
 * Minimum size for touch targets (in pixels).
 */
export const MIN_TOUCH_TARGET_SIZE = 44

/**
 * Hit radius multiplier for touch devices.
 */
export const TOUCH_HIT_RADIUS_MULTIPLIER = 1.5

// =============================================================================
// Animation Configuration
// =============================================================================

/**
 * Duration for quick UI transitions (in ms).
 */
export const TRANSITION_FAST_MS = 150

/**
 * Duration for normal UI transitions (in ms).
 */
export const TRANSITION_NORMAL_MS = 250
