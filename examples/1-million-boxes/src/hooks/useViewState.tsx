import { createContext, useCallback, useContext, useState } from "react"
import { H, W } from "../lib/edge-math"
import { DEFAULT_ZOOM, MAX_ZOOM, MIN_ZOOM, ZOOM_STEP } from "../lib/config"
import type { ReactNode } from "react"

// Re-export zoom constants for components that need them
export { MIN_ZOOM, MAX_ZOOM, DEFAULT_ZOOM }

export interface ViewState {
  centerX: number // 0..W (grid width)
  centerY: number // 0..H (grid height)
  zoom: number // MIN_ZOOM..MAX_ZOOM
}

export interface CanvasSize {
  width: number
  height: number
}

export interface ViewStateActions {
  view: ViewState
  canvasSize: CanvasSize
  setCanvasSize: (size: CanvasSize) => void
  pan: (deltaX: number, deltaY: number) => void
  zoomTo: (newZoom: number, focalX?: number, focalY?: number) => void
  zoomIn: () => void
  zoomOut: () => void
  resetView: () => void
  jumpTo: (x: number, y: number) => void
}

export const ViewStateContext = createContext<ViewStateActions | null>(null)

export function useViewStateContext(): ViewStateActions {
  const context = useContext(ViewStateContext)
  if (!context) {
    throw new Error(
      `useViewStateContext must be used within a ViewStateContext.Provider`
    )
  }
  return context
}

export function useViewState(): ViewStateActions {
  const [view, setView] = useState<ViewState>({
    centerX: W / 2,
    centerY: H / 2,
    zoom: DEFAULT_ZOOM,
  })

  const [canvasSize, setCanvasSize] = useState<CanvasSize>({
    width: 0,
    height: 0,
  })

  const pan = useCallback((deltaX: number, deltaY: number) => {
    setView((v) => ({
      ...v,
      centerX: Math.max(0, Math.min(W, v.centerX - deltaX / v.zoom)),
      centerY: Math.max(0, Math.min(H, v.centerY - deltaY / v.zoom)),
    }))
  }, [])

  const zoomTo = useCallback(
    (newZoom: number, focalX?: number, focalY?: number) => {
      setView((v) => {
        const clampedZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, newZoom))

        // If focal point provided, adjust center to keep that point fixed
        if (focalX !== undefined && focalY !== undefined) {
          const scale = clampedZoom / v.zoom
          return {
            centerX: Math.max(
              0,
              Math.min(W, focalX + (v.centerX - focalX) / scale)
            ),
            centerY: Math.max(
              0,
              Math.min(H, focalY + (v.centerY - focalY) / scale)
            ),
            zoom: clampedZoom,
          }
        }

        return { ...v, zoom: clampedZoom }
      })
    },
    []
  )

  const zoomIn = useCallback(() => {
    setView((v) => ({
      ...v,
      zoom: Math.min(MAX_ZOOM, v.zoom * ZOOM_STEP),
    }))
  }, [])

  const zoomOut = useCallback(() => {
    setView((v) => ({
      ...v,
      zoom: Math.max(MIN_ZOOM, v.zoom / ZOOM_STEP),
    }))
  }, [])

  const resetView = useCallback(() => {
    setView({
      centerX: W / 2,
      centerY: H / 2,
      zoom: DEFAULT_ZOOM,
    })
  }, [])

  const jumpTo = useCallback((x: number, y: number) => {
    setView((v) => ({
      ...v,
      centerX: Math.max(0, Math.min(W, x)),
      centerY: Math.max(0, Math.min(H, y)),
    }))
  }, [])

  return {
    view,
    canvasSize,
    setCanvasSize,
    pan,
    zoomTo,
    zoomIn,
    zoomOut,
    resetView,
    jumpTo,
  }
}

export interface ViewStateProviderProps {
  children: ReactNode
}

export function ViewStateProvider({ children }: ViewStateProviderProps) {
  const viewState = useViewState()

  return (
    <ViewStateContext.Provider value={viewState}>
      {children}
    </ViewStateContext.Provider>
  )
}
