import "./ZoomControls.css"

export function ZoomControls() {
  // TODO: Connect to view state
  const handleZoomIn = () => {
    // Will be implemented in later phases
  }

  const handleZoomOut = () => {
    // Will be implemented in later phases
  }

  return (
    <div className="zoom-controls" data-testid="zoom-controls">
      <button
        className="zoom-button"
        data-testid="zoom-out"
        aria-label="Zoom out"
        onClick={handleZoomOut}
      >
        −
      </button>
      <button
        className="zoom-button"
        data-testid="zoom-in"
        aria-label="Zoom in"
        onClick={handleZoomIn}
      >
        +
      </button>
    </div>
  )
}
