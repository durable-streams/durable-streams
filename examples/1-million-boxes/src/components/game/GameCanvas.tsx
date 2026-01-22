import { useCallback, useEffect, useRef, useState } from "react"
import { useViewStateContext } from "../../hooks/useViewState"
import { useGameState } from "../../hooks/useGameState"
import { usePanZoom } from "../../hooks/usePanZoom"
import { screenToWorld } from "../../lib/view-transform"
import { findNearestEdge } from "../../lib/edge-picker"
import { renderBoxes } from "./BoxRenderer"
import { renderEdges } from "./EdgeRenderer"
import { renderDots } from "./DotRenderer"
import "./GameCanvas.css"

export function GameCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const { view, pan, zoomTo, canvasSize, setCanvasSize } = useViewStateContext()
  const { gameState, pendingEdge, placeEdge } = useGameState()
  const [hoveredEdge, setHoveredEdge] = useState<number | null>(null)

  // Handle resize
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const observer = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect
      setCanvasSize({ width, height })
    })

    observer.observe(container)
    return () => observer.disconnect()
  }, [setCanvasSize])

  // Set up pan/zoom handlers
  usePanZoom(containerRef, {
    onPan: pan,
    onZoom: (newZoom, focalX, focalY) => {
      // Convert focal point from screen to world coordinates for proper zoom centering
      if (focalX !== undefined && focalY !== undefined) {
        const worldFocal = screenToWorld(
          focalX,
          focalY,
          view,
          canvasSize.width,
          canvasSize.height
        )
        zoomTo(newZoom, worldFocal.x, worldFocal.y)
      } else {
        zoomTo(newZoom)
      }
    },
  })

  // Render loop
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || canvasSize.width === 0) return

    const ctx = canvas.getContext(`2d`)
    if (!ctx) return

    // Set canvas size (account for device pixel ratio)
    const dpr = window.devicePixelRatio || 1
    canvas.width = canvasSize.width * dpr
    canvas.height = canvasSize.height * dpr
    ctx.scale(dpr, dpr)

    // Clear with background color
    ctx.fillStyle = `#F5F5DC` // Beige/parchment background
    ctx.fillRect(0, 0, canvasSize.width, canvasSize.height)

    // Render layers in order: boxes, edges, dots
    renderBoxes(ctx, gameState, view, canvasSize.width, canvasSize.height)
    renderEdges(
      ctx,
      gameState,
      view,
      canvasSize.width,
      canvasSize.height,
      pendingEdge,
      hoveredEdge
    )
    renderDots(ctx, view, canvasSize.width, canvasSize.height)
  }, [gameState, view, canvasSize, pendingEdge, hoveredEdge])

  // Handle mouse move for edge hover
  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!canvasRef.current) return

      const rect = canvasRef.current.getBoundingClientRect()
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top

      const worldPos = screenToWorld(
        x,
        y,
        view,
        canvasSize.width,
        canvasSize.height
      )
      const edgeId = findNearestEdge(worldPos.x, worldPos.y, view.zoom)

      setHoveredEdge(edgeId)
    },
    [view, canvasSize]
  )

  // Handle click to place edge
  const handleClick = useCallback(() => {
    if (hoveredEdge !== null) {
      placeEdge(hoveredEdge)
    }
  }, [hoveredEdge, placeEdge])

  return (
    <div ref={containerRef} className="game-canvas-container">
      <canvas
        ref={canvasRef}
        className="game-canvas"
        data-testid="game-canvas"
        style={{ width: canvasSize.width, height: canvasSize.height }}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHoveredEdge(null)}
        onClick={handleClick}
      />
    </div>
  )
}
