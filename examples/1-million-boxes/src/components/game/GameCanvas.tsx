import { useCallback, useEffect, useRef, useState } from "react"
import { useViewStateContext } from "../../hooks/useViewState"
import { useGameState } from "../../hooks/useGameState"
import { usePanZoom } from "../../hooks/usePanZoom"
import { screenToWorld } from "../../lib/view-transform"
import { findNearestEdge } from "../../lib/edge-picker"
import { TouchFeedback, useTouchFeedback } from "../ui/TouchFeedback"
import { renderBoxes } from "./BoxRenderer"
import { renderEdges } from "./EdgeRenderer"
import { renderDots } from "./DotRenderer"
import "./GameCanvas.css"

/**
 * Trigger haptic feedback if available
 */
function triggerHapticFeedback(pattern: number | Array<number> = 10) {
  if (`vibrate` in navigator) {
    navigator.vibrate(pattern)
  }
}

export function GameCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const { view, pan, zoomTo, canvasSize, setCanvasSize } = useViewStateContext()
  const { gameState, pendingEdge, placeEdge } = useGameState()
  const [hoveredEdge, setHoveredEdge] = useState<number | null>(null)
  const { ripples, addRipple } = useTouchFeedback()

  // Track touch state for tap vs drag detection
  const touchStartPos = useRef<{ x: number; y: number } | null>(null)
  const touchMoved = useRef(false)

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
  const { setCurrentZoom } = usePanZoom(containerRef, {
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

  // Sync external zoom changes with usePanZoom
  useEffect(() => {
    setCurrentZoom(view.zoom)
  }, [view.zoom, setCurrentZoom])

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
      const edgeId = findNearestEdge(worldPos.x, worldPos.y, view.zoom, false)

      setHoveredEdge(edgeId)
    },
    [view, canvasSize]
  )

  // Handle click to place edge
  const handleClick = useCallback(() => {
    if (hoveredEdge !== null) {
      placeEdge(hoveredEdge)
      triggerHapticFeedback(15)
    }
  }, [hoveredEdge, placeEdge])

  // Handle touch start - track position for tap detection
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 1) {
      const touch = e.touches[0]
      touchStartPos.current = { x: touch.clientX, y: touch.clientY }
      touchMoved.current = false
    }
  }, [])

  // Handle touch move - detect if user is dragging vs tapping
  const handleTouchMove = useCallback(() => {
    // usePanZoom handles the actual panning, we just track movement state
    touchMoved.current = true
  }, [])

  // Handle touch end - place edge on tap (not drag)
  const handleTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      // Only process if this was a tap (not a pan/zoom gesture)
      if (
        touchMoved.current ||
        !touchStartPos.current ||
        e.touches.length > 0
      ) {
        touchStartPos.current = null
        return
      }

      const canvas = canvasRef.current
      if (!canvas) return

      const rect = canvas.getBoundingClientRect()
      const x = touchStartPos.current.x - rect.left
      const y = touchStartPos.current.y - rect.top

      const worldPos = screenToWorld(
        x,
        y,
        view,
        canvasSize.width,
        canvasSize.height
      )
      const edgeId = findNearestEdge(worldPos.x, worldPos.y, view.zoom, true)

      if (edgeId !== null) {
        // Add visual feedback
        addRipple(x, y)
        // Haptic feedback
        triggerHapticFeedback(15)
        // Place the edge
        placeEdge(edgeId)
      }

      touchStartPos.current = null
    },
    [view, canvasSize, placeEdge, addRipple]
  )

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
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      />
      <TouchFeedback ripples={ripples} />
    </div>
  )
}
