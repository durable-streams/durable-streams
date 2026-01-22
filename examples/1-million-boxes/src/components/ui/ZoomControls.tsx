import {
  DEFAULT_ZOOM,
  MAX_ZOOM,
  MIN_ZOOM,
  useViewStateContext,
} from "../../hooks/useViewState"
import "./ZoomControls.css"

export function ZoomControls() {
  const { view, zoomIn, zoomOut, resetView } = useViewStateContext()

  // Convert zoom level to percentage for display
  const zoomPercent = Math.round(view.zoom * 100)

  const isAtMin = view.zoom <= MIN_ZOOM
  const isAtMax = view.zoom >= MAX_ZOOM
  const isDefault = Math.abs(view.zoom - DEFAULT_ZOOM) < 0.01

  return (
    <div className="zoom-controls" data-testid="zoom-controls">
      <button
        className="zoom-button zoom-button-left"
        data-testid="zoom-out"
        aria-label="Zoom out"
        onClick={zoomOut}
        disabled={isAtMin}
      >
        −
      </button>
      <button
        className="zoom-button zoom-button-center"
        data-testid="zoom-level"
        aria-label="Reset zoom"
        onClick={resetView}
        title="Click to reset"
        disabled={isDefault}
      >
        {zoomPercent}%
      </button>
      <button
        className="zoom-button zoom-button-right"
        data-testid="zoom-in"
        aria-label="Zoom in"
        onClick={zoomIn}
        disabled={isAtMax}
      >
        +
      </button>
    </div>
  )
}
