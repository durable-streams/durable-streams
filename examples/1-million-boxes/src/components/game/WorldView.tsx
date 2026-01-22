import { useCallback, useEffect, useRef } from "react"
import { W } from "../../lib/edge-math"
import { useViewStateContext } from "../../hooks/useViewState"
import { useGameStateContext } from "../../contexts/game-state-context"
import { MinimapRenderer } from "./MinimapRenderer"
import "./WorldView.css"

const MINIMAP_SIZE = 150

export function WorldView() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rendererRef = useRef<MinimapRenderer | null>(null)
  const { gameState, version } = useGameStateContext()
  const { view, canvasSize, jumpTo } = useViewStateContext()

  // Initialize renderer
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    rendererRef.current = new MinimapRenderer(canvas, MINIMAP_SIZE)

    return () => {
      rendererRef.current = null
    }
  }, [])

  // Update minimap when game state or view changes
  useEffect(() => {
    const renderer = rendererRef.current
    if (!renderer) return

    // Render all boxes
    renderer.renderFull(gameState)
    renderer.render()

    // Draw viewport rectangle if we have canvas size
    if (canvasSize.width > 0 && canvasSize.height > 0) {
      renderer.drawViewport(view, canvasSize.width, canvasSize.height)
    }
  }, [gameState, version, view, canvasSize])

  // Handle click to navigate
  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current
      if (!canvas) return

      const rect = canvas.getBoundingClientRect()
      const clickX = e.clientX - rect.left
      const clickY = e.clientY - rect.top

      // Convert minimap coordinates to world coordinates
      // Use actual displayed size for accurate click mapping (handles CSS scaling)
      const displayedWidth = rect.width
      const displayedHeight = rect.height
      const worldX = (clickX / displayedWidth) * W
      const worldY = (clickY / displayedHeight) * W

      jumpTo(worldX, worldY)
    },
    [jumpTo]
  )

  return (
    <canvas
      ref={canvasRef}
      className="world-view"
      data-testid="world-view"
      onClick={handleClick}
    />
  )
}
