/**
 * Centralized configuration for the 1 Million Boxes game.
 *
 * All configurable values should be defined here to provide a single
 * source of truth across the codebase.
 */

// =============================================================================
// Stream Configuration
// =============================================================================

/**
 * Base URL for the Durable Streams server (used by backend/DO).
 * Can be overridden via VITE_DURABLE_STREAMS_URL environment variable.
 */
export const DURABLE_STREAMS_URL =
  import.meta.env.VITE_DURABLE_STREAMS_URL || `http://localhost:4437/v1/stream`

/**
 * The stream path for the game events.
 */
export const GAME_STREAM_PATH = `/game`

/**
 * Full URL for the game stream (direct access).
 */
export const GAME_STREAM_URL = `${DURABLE_STREAMS_URL}${GAME_STREAM_PATH}`

/**
 * API endpoint for proxied stream access through the worker.
 * This is used for SSE connections in production.
 */
export const STREAM_PROXY_ENDPOINT = `/api/stream/game`

/**
 * Whether to use the proxy for stream connections.
 * In production (when VITE_USE_STREAM_PROXY is set), we proxy through the worker.
 * In development, we connect directly to the stream server.
 */
export const USE_STREAM_PROXY = import.meta.env.VITE_USE_STREAM_PROXY === `true`

/**
 * Delay before reconnecting after a stream connection error (in ms).
 */
export const STREAM_RECONNECT_DELAY_MS = 3000

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
// Zoom Configuration
// =============================================================================

/**
 * Minimum zoom level (fully zoomed out).
 */
export const MIN_ZOOM = 0.1

/**
 * Maximum zoom level (fully zoomed in).
 */
export const MAX_ZOOM = 10

/**
 * Default zoom level on initial load.
 */
export const DEFAULT_ZOOM = 1

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
