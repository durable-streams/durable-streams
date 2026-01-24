import {
  MAX_ZOOM,
  MIN_ZOOM,
  useViewStateContext,
} from "../../hooks/useViewState"
import "./ZoomControls.css"

interface ZoomControlsProps {
  className?: string
}

export function ZoomControls({ className }: ZoomControlsProps) {
  const { view, zoomIn, zoomOut } = useViewStateContext()

  const isAtMin = view.zoom <= MIN_ZOOM
  const isAtMax = view.zoom >= MAX_ZOOM

  return (
    <div
      className={`zoom-controls ${className ?? ``}`}
      data-testid="zoom-controls"
    >
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
