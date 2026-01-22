import type { ViewState } from "../hooks/useViewState"

/**
 * Convert world coordinates to screen coordinates.
 */
export function worldToScreen(
  wx: number,
  wy: number,
  view: ViewState,
  canvasWidth: number,
  canvasHeight: number
): { x: number; y: number } {
  const cx = canvasWidth / 2
  const cy = canvasHeight / 2
  return {
    x: cx + (wx - view.centerX) * view.zoom,
    y: cy + (wy - view.centerY) * view.zoom,
  }
}

/**
 * Convert screen coordinates to world coordinates.
 */
export function screenToWorld(
  sx: number,
  sy: number,
  view: ViewState,
  canvasWidth: number,
  canvasHeight: number
): { x: number; y: number } {
  const cx = canvasWidth / 2
  const cy = canvasHeight / 2
  return {
    x: view.centerX + (sx - cx) / view.zoom,
    y: view.centerY + (sy - cy) / view.zoom,
  }
}

/**
 * Get the visible world bounds for the current view.
 */
export function getVisibleBounds(
  view: ViewState,
  canvasWidth: number,
  canvasHeight: number
): { minX: number; minY: number; maxX: number; maxY: number } {
  const halfW = canvasWidth / view.zoom / 2
  const halfH = canvasHeight / view.zoom / 2

  return {
    minX: Math.floor(view.centerX - halfW),
    minY: Math.floor(view.centerY - halfH),
    maxX: Math.ceil(view.centerX + halfW),
    maxY: Math.ceil(view.centerY + halfH),
  }
}
