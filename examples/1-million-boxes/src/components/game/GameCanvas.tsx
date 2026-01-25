import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useViewStateContext } from "../../hooks/useViewState"
import { useGameState } from "../../hooks/useGameState"
import { usePanZoom } from "../../hooks/usePanZoom"
import { useQuota } from "../../contexts/quota-context"
import {
  getScale,
  getVisibleBounds,
  screenRectToWorldBounds,
  screenToWorld,
  worldToScreen,
} from "../../lib/view-transform"
import { H, W, edgeIdToCoords } from "../../../shared/edge-math"
import { findNearestEdge } from "../../lib/edge-picker"
import { getDebugConfig, subscribeDebugConfig } from "../../lib/debug-config"
import { TouchFeedback, useTouchFeedback } from "../ui/TouchFeedback"
import { TEAMS, TEAM_COLORS } from "../../../shared/teams"
import { renderBoxes } from "./BoxRenderer"
import { renderEdges } from "./EdgeRenderer"
import { renderDots } from "./DotRenderer"
import type { DebugConfig } from "../../lib/debug-config"
import "./GameCanvas.css"

const POP_DURATION = 800 // ms - should match CSS animation

const BACKGROUND_COLOR = `#F5F5DC`

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
  const {
    gameState,
    boxBitmap,
    pendingEdge,
    placeEdge,
    recentEvents,
    version,
    isLoading,
    isReadyToRender,
    notifyCanvasRendered,
    isGameComplete,
  } = useGameState()
  const { setBonusPosition } = useQuota()
  const [hoveredEdge, setHoveredEdge] = useState<number | null>(null)
  const lastEdgeScreenPosRef = useRef<{ x: number; y: number } | null>(null)
  const { ripples, addRipple } = useTouchFeedback()
  const [debugConfig, setDebugConfig] = useState<DebugConfig>(getDebugConfig)

  const prevViewRef = useRef<typeof view | null>(null)
  const prevCanvasSizeRef = useRef<typeof canvasSize | null>(null)
  const prevHoveredEdgeRef = useRef<number | null>(null)
  const prevPendingEdgeRef = useRef<number | null>(null)
  const prevDebugConfigRef = useRef<DebugConfig | null>(null)
  const lastProcessedEventIdRef = useRef<number>(-1)
  const zoomRedrawTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastZoomRedrawRef = useRef<number>(0)
  const zoomSnapshotRef = useRef<HTMLCanvasElement | null>(null)
  const hasDrawnRef = useRef(false)
  const latestStateRef = useRef({
    view,
    canvasSize,
    pendingEdge,
    hoveredEdge,
    debugConfig,
    gameState,
    boxBitmap,
  })

  // Subscribe to debug config changes
  useEffect(() => {
    return subscribeDebugConfig(setDebugConfig)
  }, [])

  // Track touch state for tap vs drag detection
  const touchStartPos = useRef<{ x: number; y: number } | null>(null)
  const touchMoved = useRef(false)

  // Track mouse state for click vs drag detection
  const mouseStartPos = useRef<{ x: number; y: number } | null>(null)
  const mouseMoved = useRef(false)

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

  useEffect(() => {
    latestStateRef.current = {
      view,
      canvasSize,
      pendingEdge,
      hoveredEdge,
      debugConfig,
      gameState,
      boxBitmap,
    }
  }, [
    view,
    canvasSize,
    pendingEdge,
    hoveredEdge,
    debugConfig,
    gameState,
    boxBitmap,
  ])

  const setupCanvas = useCallback(
    (ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement) => {
      const dpr = window.devicePixelRatio || 1
      const targetWidth = Math.floor(canvasSize.width * dpr)
      const targetHeight = Math.floor(canvasSize.height * dpr)
      if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
        canvas.width = targetWidth
        canvas.height = targetHeight
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      return dpr
    },
    [canvasSize.width, canvasSize.height]
  )

  const renderLayers = useCallback(
    (
      ctx: CanvasRenderingContext2D,
      renderState: {
        view: typeof view
        canvasSize: typeof canvasSize
        pendingEdge: typeof pendingEdge
        hoveredEdge: typeof hoveredEdge
        debugConfig: typeof debugConfig
        gameState: typeof gameState
        boxBitmap: typeof boxBitmap
      },
      bounds?: { minX: number; minY: number; maxX: number; maxY: number },
      clipRect?: { x: number; y: number; width: number; height: number }
    ) => {
      const {
        view: renderView,
        canvasSize: renderCanvasSize,
        pendingEdge: renderPendingEdge,
        hoveredEdge: renderHoveredEdge,
        debugConfig: renderDebugConfig,
        gameState: renderGameState,
        boxBitmap: renderBoxBitmap,
      } = renderState

      if (clipRect) {
        ctx.save()
        ctx.beginPath()
        ctx.rect(clipRect.x, clipRect.y, clipRect.width, clipRect.height)
        ctx.clip()
        ctx.fillStyle = BACKGROUND_COLOR
        ctx.fillRect(clipRect.x, clipRect.y, clipRect.width, clipRect.height)
      } else {
        ctx.fillStyle = BACKGROUND_COLOR
        ctx.fillRect(0, 0, renderCanvasSize.width, renderCanvasSize.height)
      }

      if (renderDebugConfig.renderShadedBoxes) {
        renderBoxes(
          ctx,
          renderGameState,
          renderView,
          renderCanvasSize.width,
          renderCanvasSize.height,
          renderBoxBitmap
        )
      }

      renderEdges(
        ctx,
        renderGameState,
        renderView,
        renderCanvasSize.width,
        renderCanvasSize.height,
        renderPendingEdge,
        renderHoveredEdge,
        renderDebugConfig.renderGridLines,
        renderDebugConfig.renderDrawnLines,
        bounds
      )

      if (renderDebugConfig.renderDots) {
        renderDots(
          ctx,
          renderView,
          renderCanvasSize.width,
          renderCanvasSize.height
        )
      }

      if (clipRect) {
        ctx.restore()
      }
    },
    []
  )

  const performFullRedraw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas || canvasSize.width === 0) return

    const ctx = canvas.getContext(`2d`)
    if (!ctx) return

    const renderState = latestStateRef.current
    if (renderState.canvasSize.width === 0) return
    setupCanvas(ctx, canvas)
    renderLayers(ctx, renderState)
  }, [canvasSize.height, canvasSize.width, renderLayers, setupCanvas])

  const captureZoomSnapshot = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const snapshot = zoomSnapshotRef.current ?? document.createElement(`canvas`)
    zoomSnapshotRef.current = snapshot
    if (snapshot.width !== canvas.width || snapshot.height !== canvas.height) {
      snapshot.width = canvas.width
      snapshot.height = canvas.height
    }
    const snapshotCtx = snapshot.getContext(`2d`)
    if (!snapshotCtx) return
    snapshotCtx.setTransform(1, 0, 0, 1, 0, 0)
    snapshotCtx.drawImage(canvas, 0, 0)
  }, [])

  const scheduleZoomRedraw = useCallback(() => {
    const throttleMs = 1000 / 12
    const now = Date.now()
    const elapsed = now - lastZoomRedrawRef.current

    if (elapsed >= throttleMs) {
      lastZoomRedrawRef.current = now
      performFullRedraw()
      return
    }

    if (zoomRedrawTimerRef.current) return

    zoomRedrawTimerRef.current = setTimeout(() => {
      zoomRedrawTimerRef.current = null
      lastZoomRedrawRef.current = Date.now()
      performFullRedraw()
    }, throttleMs - elapsed)
  }, [performFullRedraw])

  useEffect(() => {
    return () => {
      if (zoomRedrawTimerRef.current) {
        clearTimeout(zoomRedrawTimerRef.current)
        zoomRedrawTimerRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || canvasSize.width === 0) return

    const ctx = canvas.getContext(`2d`)
    if (!ctx) return

    const dpr = setupCanvas(ctx, canvas)
    const renderState = {
      view,
      canvasSize,
      pendingEdge,
      hoveredEdge,
      debugConfig,
      gameState,
      boxBitmap,
    }
    latestStateRef.current = renderState
    if (isLoading && !isReadyToRender) {
      return
    }

    if (isLoading && isReadyToRender) {
      performFullRedraw()
      hasDrawnRef.current = true
      notifyCanvasRendered()
      prevViewRef.current = view
      prevCanvasSizeRef.current = canvasSize
      prevDebugConfigRef.current = debugConfig
      prevHoveredEdgeRef.current = hoveredEdge
      prevPendingEdgeRef.current = pendingEdge
      return
    }

    const prevView = prevViewRef.current
    const prevCanvasSize = prevCanvasSizeRef.current
    const prevDebugConfig = prevDebugConfigRef.current

    const debugChanged =
      !prevDebugConfig ||
      prevDebugConfig.renderShadedBoxes !== debugConfig.renderShadedBoxes ||
      prevDebugConfig.renderDots !== debugConfig.renderDots ||
      prevDebugConfig.renderGridLines !== debugConfig.renderGridLines ||
      prevDebugConfig.renderDrawnLines !== debugConfig.renderDrawnLines

    const sizeChanged =
      !prevCanvasSize ||
      prevCanvasSize.width !== canvasSize.width ||
      prevCanvasSize.height !== canvasSize.height

    if (!hasDrawnRef.current) {
      performFullRedraw()
      hasDrawnRef.current = true
      prevViewRef.current = view
      prevCanvasSizeRef.current = canvasSize
      prevDebugConfigRef.current = debugConfig
      prevHoveredEdgeRef.current = hoveredEdge
      prevPendingEdgeRef.current = pendingEdge
      return
    }

    if (sizeChanged || debugChanged || !prevView) {
      performFullRedraw()
      prevViewRef.current = view
      prevCanvasSizeRef.current = canvasSize
      prevDebugConfigRef.current = debugConfig
      prevHoveredEdgeRef.current = hoveredEdge
      prevPendingEdgeRef.current = pendingEdge
      return
    }

    const redrawScreenRect = (rect: {
      x: number
      y: number
      width: number
      height: number
    }) => {
      if (rect.width <= 0 || rect.height <= 0) return
      const bounds = screenRectToWorldBounds(
        view,
        canvasSize.width,
        canvasSize.height,
        rect.x,
        rect.y,
        rect.width,
        rect.height
      )
      renderLayers(ctx, renderState, bounds, rect)
    }

    const zoomChanged = prevView.zoom !== view.zoom
    if (zoomChanged) {
      captureZoomSnapshot()
      const scaleRatio = getScale(view) / getScale(prevView)
      const cx = canvasSize.width / 2
      const cy = canvasSize.height / 2
      const offsetX =
        (cx -
          scaleRatio * cx +
          (prevView.centerX - view.centerX) * getScale(view)) *
        dpr
      const offsetY =
        (cy -
          scaleRatio * cy +
          (prevView.centerY - view.centerY) * getScale(view)) *
        dpr

      const snapshot = zoomSnapshotRef.current
      if (snapshot) {
        ctx.setTransform(scaleRatio, 0, 0, scaleRatio, offsetX, offsetY)
        ctx.drawImage(snapshot, 0, 0)
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      }

      const prevBounds = getVisibleBounds(
        prevView,
        canvasSize.width,
        canvasSize.height
      )
      const prevTopLeft = worldToScreen(
        prevBounds.minX,
        prevBounds.minY,
        view,
        canvasSize.width,
        canvasSize.height
      )
      const prevBottomRight = worldToScreen(
        prevBounds.maxX,
        prevBounds.maxY,
        view,
        canvasSize.width,
        canvasSize.height
      )

      const rectLeft = Math.min(prevTopLeft.x, prevBottomRight.x)
      const rectRight = Math.max(prevTopLeft.x, prevBottomRight.x)
      const rectTop = Math.min(prevTopLeft.y, prevBottomRight.y)
      const rectBottom = Math.max(prevTopLeft.y, prevBottomRight.y)

      if (rectLeft > 0) {
        redrawScreenRect({
          x: 0,
          y: 0,
          width: rectLeft,
          height: canvasSize.height,
        })
      }
      if (rectRight < canvasSize.width) {
        redrawScreenRect({
          x: rectRight,
          y: 0,
          width: canvasSize.width - rectRight,
          height: canvasSize.height,
        })
      }
      if (rectTop > 0) {
        redrawScreenRect({
          x: 0,
          y: 0,
          width: canvasSize.width,
          height: rectTop,
        })
      }
      if (rectBottom < canvasSize.height) {
        redrawScreenRect({
          x: 0,
          y: rectBottom,
          width: canvasSize.width,
          height: canvasSize.height - rectBottom,
        })
      }

      scheduleZoomRedraw()
      prevViewRef.current = view
      prevCanvasSizeRef.current = canvasSize
      prevDebugConfigRef.current = debugConfig
      prevHoveredEdgeRef.current = hoveredEdge
      prevPendingEdgeRef.current = pendingEdge
      return
    }

    const scale = getScale(view)
    const deltaX = (prevView.centerX - view.centerX) * scale
    const deltaY = (prevView.centerY - view.centerY) * scale
    const centerChanged = deltaX !== 0 || deltaY !== 0

    if (centerChanged) {
      if (
        Math.abs(deltaX) >= canvasSize.width ||
        Math.abs(deltaY) >= canvasSize.height
      ) {
        performFullRedraw()
      } else {
        ctx.setTransform(1, 0, 0, 1, 0, 0)
        ctx.drawImage(
          canvas,
          Math.round(deltaX * dpr),
          Math.round(deltaY * dpr)
        )
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

        if (deltaX > 0) {
          redrawScreenRect({
            x: 0,
            y: 0,
            width: deltaX,
            height: canvasSize.height,
          })
        } else if (deltaX < 0) {
          redrawScreenRect({
            x: canvasSize.width + deltaX,
            y: 0,
            width: -deltaX,
            height: canvasSize.height,
          })
        }

        if (deltaY > 0) {
          redrawScreenRect({
            x: 0,
            y: 0,
            width: canvasSize.width,
            height: deltaY,
          })
        } else if (deltaY < 0) {
          redrawScreenRect({
            x: 0,
            y: canvasSize.height + deltaY,
            width: canvasSize.width,
            height: -deltaY,
          })
        }
      }
    }

    const edgeIdsToRedraw = new Set<number>()
    const prevPending = prevPendingEdgeRef.current
    const prevHovered = prevHoveredEdgeRef.current

    if (prevPending !== pendingEdge) {
      if (prevPending !== null) edgeIdsToRedraw.add(prevPending)
      if (pendingEdge !== null) edgeIdsToRedraw.add(pendingEdge)
    }

    if (prevHovered !== hoveredEdge) {
      if (prevHovered !== null) edgeIdsToRedraw.add(prevHovered)
      if (hoveredEdge !== null) edgeIdsToRedraw.add(hoveredEdge)
    }

    for (const event of recentEvents) {
      if (event.id > lastProcessedEventIdRef.current) {
        edgeIdsToRedraw.add(event.edgeId)
        lastProcessedEventIdRef.current = Math.max(
          lastProcessedEventIdRef.current,
          event.id
        )
      }
    }

    if (edgeIdsToRedraw.size > 0) {
      const lineWidth = Math.max(0.5, scale * 0.1)
      const padding = Math.max(2, lineWidth * 2)

      for (const edgeId of edgeIdsToRedraw) {
        const coords = edgeIdToCoords(edgeId)
        const minX = Math.max(0, coords.x - (coords.horizontal ? 0 : 1))
        const maxX = Math.min(W, coords.x + 1)
        const minY = Math.max(0, coords.y - (coords.horizontal ? 1 : 0))
        const maxY = Math.min(H, coords.y + 1)

        const topLeft = worldToScreen(
          minX,
          minY,
          view,
          canvasSize.width,
          canvasSize.height
        )
        const bottomRight = worldToScreen(
          maxX,
          maxY,
          view,
          canvasSize.width,
          canvasSize.height
        )

        const x = Math.min(topLeft.x, bottomRight.x) - padding
        const y = Math.min(topLeft.y, bottomRight.y) - padding
        const width = Math.abs(bottomRight.x - topLeft.x) + padding * 2
        const height = Math.abs(bottomRight.y - topLeft.y) + padding * 2

        const clippedX = Math.max(0, x)
        const clippedY = Math.max(0, y)
        const clippedWidth = Math.min(canvasSize.width - clippedX, width)
        const clippedHeight = Math.min(canvasSize.height - clippedY, height)

        redrawScreenRect({
          x: clippedX,
          y: clippedY,
          width: clippedWidth,
          height: clippedHeight,
        })
      }
    }

    prevViewRef.current = view
    prevCanvasSizeRef.current = canvasSize
    prevDebugConfigRef.current = debugConfig
    prevHoveredEdgeRef.current = hoveredEdge
    prevPendingEdgeRef.current = pendingEdge
  }, [
    boxBitmap,
    canvasSize,
    captureZoomSnapshot,
    debugConfig,
    gameState,
    hoveredEdge,
    pendingEdge,
    performFullRedraw,
    recentEvents,
    renderLayers,
    scheduleZoomRedraw,
    setupCanvas,
    view,
    version,
  ])

  // Calculate pops for other players' moves in viewport
  const canvasPops = useMemo(() => {
    const now = Date.now()

    return recentEvents
      .filter((e) => !e.isLocal && now - e.timestamp < POP_DURATION)
      .map((event) => {
        const coords = edgeIdToCoords(event.edgeId)
        // Get edge center position in world coordinates
        const worldX = coords.horizontal ? coords.x + 0.5 : coords.x
        const worldY = coords.horizontal ? coords.y : coords.y + 0.5

        // Convert to screen coordinates (relative to canvas)
        const screenPos = worldToScreen(
          worldX,
          worldY,
          view,
          canvasSize.width,
          canvasSize.height
        )

        // Check if in viewport (with some margin for the pop animation)
        // Container has overflow:hidden so pops outside will be clipped
        const margin = 50
        if (
          screenPos.x < -margin ||
          screenPos.x > canvasSize.width + margin ||
          screenPos.y < -margin ||
          screenPos.y > canvasSize.height + margin
        ) {
          return null
        }

        // Get team color
        const teamName = TEAMS[event.teamId]
        const color = TEAM_COLORS[teamName].primary

        return {
          key: `${event.id}`,
          x: screenPos.x,
          y: screenPos.y,
          color,
          age: now - event.timestamp,
        }
      })
      .filter((pop): pop is NonNullable<typeof pop> => pop !== null)
  }, [recentEvents, view, canvasSize])

  // Handle mouse down - track position for click vs drag detection
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    mouseStartPos.current = { x: e.clientX, y: e.clientY }
    mouseMoved.current = false
  }, [])

  // Handle mouse move for edge hover and drag detection
  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      // Check if mouse has moved significantly during a drag (button pressed)
      // Use a small threshold to avoid triggering on tiny movements
      if (mouseStartPos.current && e.buttons > 0) {
        const dx = e.clientX - mouseStartPos.current.x
        const dy = e.clientY - mouseStartPos.current.y
        const distance = Math.sqrt(dx * dx + dy * dy)
        if (distance > 5) {
          mouseMoved.current = true
        }
      }

      // Disable hover when game is complete
      if (isGameComplete) {
        setHoveredEdge(null)
        return
      }

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
      const edgeId = findNearestEdge(
        worldPos.x,
        worldPos.y,
        getScale(view),
        false
      )

      setHoveredEdge(edgeId)

      // Track screen position for bonus toast
      if (edgeId !== null) {
        lastEdgeScreenPosRef.current = { x: e.clientX, y: e.clientY }
      }
    },
    [view, canvasSize, isGameComplete]
  )

  // Handle click to place edge
  const handleClick = useCallback(() => {
    // Skip if user was dragging (pan gesture)
    if (mouseMoved.current) {
      mouseStartPos.current = null
      return
    }
    mouseStartPos.current = null

    // Disable drawing when game is complete
    if (isGameComplete) return

    if (hoveredEdge !== null) {
      // Set bonus position for toast (will show if boxes are completed)
      if (lastEdgeScreenPosRef.current) {
        setBonusPosition(lastEdgeScreenPosRef.current)
      }
      placeEdge(hoveredEdge)
      triggerHapticFeedback(15)
    }
  }, [hoveredEdge, placeEdge, isGameComplete, setBonusPosition])

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
      // Disable drawing when game is complete
      if (isGameComplete) {
        touchStartPos.current = null
        return
      }

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
      const edgeId = findNearestEdge(
        worldPos.x,
        worldPos.y,
        getScale(view),
        true
      )

      if (edgeId !== null) {
        // Add visual feedback
        addRipple(x, y)
        // Haptic feedback
        triggerHapticFeedback(15)
        // Set bonus position for toast (use client coordinates)
        setBonusPosition({
          x: touchStartPos.current.x,
          y: touchStartPos.current.y,
        })
        // Place the edge
        placeEdge(edgeId)
      }

      touchStartPos.current = null
    },
    [view, canvasSize, placeEdge, addRipple, isGameComplete, setBonusPosition]
  )

  return (
    <div ref={containerRef} className="game-canvas-container">
      <canvas
        ref={canvasRef}
        className="game-canvas"
        data-testid="game-canvas"
        style={{ width: canvasSize.width, height: canvasSize.height }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHoveredEdge(null)}
        onClick={handleClick}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      />
      <TouchFeedback ripples={ripples} />
      {/* Pop animations for other players' moves */}
      {canvasPops.map((pop) => (
        <div
          key={pop.key}
          className="game-canvas-pop"
          style={{
            left: pop.x,
            top: pop.y,
            backgroundColor: pop.color,
            animationDelay: `-${pop.age}ms`,
          }}
        />
      ))}
    </div>
  )
}
