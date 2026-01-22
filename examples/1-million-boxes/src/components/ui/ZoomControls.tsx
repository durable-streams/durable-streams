import { useState } from "react"
import "./ZoomControls.css"

const MIN_ZOOM = 25
const MAX_ZOOM = 200
const ZOOM_STEP = 25
const DEFAULT_ZOOM = 100

export function ZoomControls() {
  // TODO: Replace with ViewStateContext when available
  const [zoom, setZoom] = useState(DEFAULT_ZOOM)

  const handleZoomIn = () => {
    setZoom((z) => Math.min(MAX_ZOOM, z + ZOOM_STEP))
  }

  const handleZoomOut = () => {
    setZoom((z) => Math.max(MIN_ZOOM, z - ZOOM_STEP))
  }

  const handleReset = () => {
    setZoom(DEFAULT_ZOOM)
  }

  const isAtMin = zoom <= MIN_ZOOM
  const isAtMax = zoom >= MAX_ZOOM

  return (
    <div className="zoom-controls" data-testid="zoom-controls">
      <button
        className="zoom-button zoom-button-left"
        data-testid="zoom-out"
        aria-label="Zoom out"
        onClick={handleZoomOut}
        disabled={isAtMin}
      >
        −
      </button>
      <button
        className="zoom-button zoom-button-center"
        data-testid="zoom-level"
        aria-label="Reset zoom"
        onClick={handleReset}
        title="Click to reset"
      >
        {zoom}%
      </button>
      <button
        className="zoom-button zoom-button-right"
        data-testid="zoom-in"
        aria-label="Zoom in"
        onClick={handleZoomIn}
        disabled={isAtMax}
      >
        +
      </button>
    </div>
  )
}
