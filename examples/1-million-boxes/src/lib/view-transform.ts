import { DOT_SPACING } from "./config"
import type { ViewState } from "../hooks/useViewState"

/**
 * Get the effective scale factor (pixels per grid unit).
 * At zoom=1, each grid cell is DOT_SPACING pixels.
 */
export function getScale(view: ViewState): number {
  return view.zoom * DOT_SPACING
}

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
  const scale = getScale(view)
  return {
    x: cx + (wx - view.centerX) * scale,
    y: cy + (wy - view.centerY) * scale,
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
  const scale = getScale(view)
  return {
    x: view.centerX + (sx - cx) / scale,
    y: view.centerY + (sy - cy) / scale,
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
  const scale = getScale(view)
  const halfW = canvasWidth / scale / 2
  const halfH = canvasHeight / scale / 2

  return {
    minX: Math.floor(view.centerX - halfW),
    minY: Math.floor(view.centerY - halfH),
    maxX: Math.ceil(view.centerX + halfW),
    maxY: Math.ceil(view.centerY + halfH),
  }
}
