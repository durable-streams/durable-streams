/**
 * Debug configuration for performance testing.
 * Toggle individual rendering features to isolate performance bottlenecks.
 */

export interface DebugConfig {
  /** Show FPS counter overlay */
  showFps: boolean
  /** Render unplaced grid lines */
  renderGridLines: boolean
  /** Render dots at grid intersections */
  renderDots: boolean
  /** Render placed/drawn edges */
  renderDrawnLines: boolean
  /** Render shaded boxes */
  renderShadedBoxes: boolean
}

// Default config (all features enabled, debug off)
const defaultConfig: DebugConfig = {
  showFps: false,
  renderGridLines: true,
  renderDots: true,
  renderDrawnLines: true,
  renderShadedBoxes: true,
}

// Current config (mutable for easy toggling)
let currentConfig: DebugConfig = { ...defaultConfig }

// Listeners for config changes
type ConfigListener = (config: DebugConfig) => void
const listeners: Set<ConfigListener> = new Set()

/**
 * Get the current debug config.
 */
export function getDebugConfig(): DebugConfig {
  return currentConfig
}

/**
 * Update debug config (partial update).
 */
export function setDebugConfig(updates: Partial<DebugConfig>): void {
  currentConfig = { ...currentConfig, ...updates }
  listeners.forEach((listener) => listener(currentConfig))
}

/**
 * Reset debug config to defaults.
 */
export function resetDebugConfig(): void {
  currentConfig = { ...defaultConfig }
  listeners.forEach((listener) => listener(currentConfig))
}

/**
 * Subscribe to config changes.
 */
export function subscribeDebugConfig(listener: ConfigListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * Toggle debug mode (shows FPS and enables toggles).
 */
export function toggleDebugMode(): void {
  setDebugConfig({ showFps: !currentConfig.showFps })
}

// Expose to window for easy console access
interface DebugConfigAPI {
  getDebugConfig: typeof getDebugConfig
  setDebugConfig: typeof setDebugConfig
  resetDebugConfig: typeof resetDebugConfig
  subscribeDebugConfig: typeof subscribeDebugConfig
  toggleDebugMode: typeof toggleDebugMode
}

if (typeof window !== `undefined`) {
  ;(window as unknown as { debugConfig: DebugConfigAPI }).debugConfig = {
    getDebugConfig,
    setDebugConfig,
    resetDebugConfig,
    subscribeDebugConfig,
    toggleDebugMode,
  }
}
