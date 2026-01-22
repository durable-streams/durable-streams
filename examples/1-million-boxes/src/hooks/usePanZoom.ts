import { useCallback, useEffect, useRef } from "react"
import type { RefObject } from "react"

interface PanZoomOptions {
  onPan: (deltaX: number, deltaY: number) => void
  onZoom: (newZoom: number, focalX?: number, focalY?: number) => void
}

interface TouchPoint {
  id: number
  x: number
  y: number
}

/**
 * Calculate distance between two touch points
 */
function getTouchDistance(t1: TouchPoint, t2: TouchPoint): number {
  const dx = t2.x - t1.x
  const dy = t2.y - t1.y
  return Math.sqrt(dx * dx + dy * dy)
}

/**
 * Calculate center point between two touch points
 */
function getTouchCenter(
  t1: TouchPoint,
  t2: TouchPoint
): { x: number; y: number } {
  return {
    x: (t1.x + t2.x) / 2,
    y: (t1.y + t2.y) / 2,
  }
}

// Double-tap detection constants
const DOUBLE_TAP_DELAY = 300 // ms
const DOUBLE_TAP_DISTANCE = 30 // px
const DOUBLE_TAP_ZOOM_FACTOR = 2 // zoom in by 2x on double-tap

/**
 * Hook to handle pan and zoom interactions on an element.
 * Supports mouse drag for panning, mouse wheel for zooming,
 * and touch gestures (single touch pan, pinch to zoom, double-tap to zoom).
 */
export function usePanZoom(
  containerRef: RefObject<HTMLElement | null>,
  options: PanZoomOptions
) {
  const { onPan, onZoom } = options
  const isPanning = useRef(false)
  const lastPos = useRef({ x: 0, y: 0 })
  const currentZoom = useRef(1)

  // Touch state
  const activeTouches = useRef<Map<number, TouchPoint>>(new Map())
  const lastPinchDistance = useRef<number | null>(null)
  const lastPinchCenter = useRef<{ x: number; y: number } | null>(null)

  // Double-tap detection
  const lastTapTime = useRef(0)
  const lastTapPos = useRef({ x: 0, y: 0 })

  // Setter for external zoom sync
  const setCurrentZoom = useCallback((zoom: number) => {
    currentZoom.current = zoom
  }, [])

  const handleMouseDown = useCallback((e: MouseEvent) => {
    if (e.button === 0) {
      // Left mouse button
      isPanning.current = true
      lastPos.current = { x: e.clientX, y: e.clientY }
    }
  }, [])

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (isPanning.current) {
        const deltaX = e.clientX - lastPos.current.x
        const deltaY = e.clientY - lastPos.current.y
        lastPos.current = { x: e.clientX, y: e.clientY }
        onPan(deltaX, deltaY)
      }
    },
    [onPan]
  )

  const handleMouseUp = useCallback(() => {
    isPanning.current = false
  }, [])

  const handleWheel = useCallback(
    (e: WheelEvent) => {
      e.preventDefault()

      const container = containerRef.current
      if (!container) return

      const rect = container.getBoundingClientRect()
      const focalX = e.clientX - rect.left
      const focalY = e.clientY - rect.top

      // Calculate zoom factor based on wheel delta
      const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1
      const newZoom = currentZoom.current * zoomFactor
      currentZoom.current = newZoom

      onZoom(newZoom, focalX, focalY)
    },
    [containerRef, onZoom]
  )

  // Touch event handlers
  const handleTouchStart = useCallback(
    (e: TouchEvent) => {
      e.preventDefault()

      const container = containerRef.current
      if (!container) return

      const rect = container.getBoundingClientRect()

      // Track all new touches
      for (const touch of Array.from(e.changedTouches)) {
        activeTouches.current.set(touch.identifier, {
          id: touch.identifier,
          x: touch.clientX - rect.left,
          y: touch.clientY - rect.top,
        })
      }

      const touchCount = activeTouches.current.size

      if (touchCount === 1) {
        // Single touch - check for double-tap
        const now = Date.now()
        const touches = Array.from(activeTouches.current.values())
        const touch = touches[0]

        const timeDiff = now - lastTapTime.current
        const dx = touch.x - lastTapPos.current.x
        const dy = touch.y - lastTapPos.current.y
        const distance = Math.sqrt(dx * dx + dy * dy)

        if (timeDiff < DOUBLE_TAP_DELAY && distance < DOUBLE_TAP_DISTANCE) {
          // Double-tap detected - zoom in
          const newZoom = currentZoom.current * DOUBLE_TAP_ZOOM_FACTOR
          currentZoom.current = newZoom
          onZoom(newZoom, touch.x, touch.y)
          lastTapTime.current = 0 // Reset to prevent triple-tap
        } else {
          lastTapTime.current = now
          lastTapPos.current = { x: touch.x, y: touch.y }
        }

        // Set up for panning
        lastPos.current = { x: touch.x, y: touch.y }
      } else if (touchCount === 2) {
        // Two touches - initialize pinch
        const touches = Array.from(activeTouches.current.values())
        lastPinchDistance.current = getTouchDistance(touches[0], touches[1])
        lastPinchCenter.current = getTouchCenter(touches[0], touches[1])
      }
    },
    [containerRef, onZoom]
  )

  const handleTouchMove = useCallback(
    (e: TouchEvent) => {
      e.preventDefault()

      const container = containerRef.current
      if (!container) return

      const rect = container.getBoundingClientRect()

      // Update touch positions
      for (const touch of Array.from(e.changedTouches)) {
        if (activeTouches.current.has(touch.identifier)) {
          activeTouches.current.set(touch.identifier, {
            id: touch.identifier,
            x: touch.clientX - rect.left,
            y: touch.clientY - rect.top,
          })
        }
      }

      const touchCount = activeTouches.current.size

      if (touchCount === 1) {
        // Single touch - pan
        const touches = Array.from(activeTouches.current.values())
        const touch = touches[0]
        const deltaX = touch.x - lastPos.current.x
        const deltaY = touch.y - lastPos.current.y
        lastPos.current = { x: touch.x, y: touch.y }
        onPan(deltaX, deltaY)
      } else if (touchCount === 2) {
        // Two touches - pinch to zoom and pan
        const touches = Array.from(activeTouches.current.values())
        const currentDistance = getTouchDistance(touches[0], touches[1])
        const currentCenter = getTouchCenter(touches[0], touches[1])

        if (
          lastPinchDistance.current !== null &&
          lastPinchCenter.current !== null
        ) {
          // Calculate zoom
          const scale = currentDistance / lastPinchDistance.current
          const newZoom = currentZoom.current * scale
          currentZoom.current = newZoom
          onZoom(newZoom, currentCenter.x, currentCenter.y)

          // Also pan while pinching
          const deltaX = currentCenter.x - lastPinchCenter.current.x
          const deltaY = currentCenter.y - lastPinchCenter.current.y
          onPan(deltaX, deltaY)
        }

        lastPinchDistance.current = currentDistance
        lastPinchCenter.current = currentCenter
      }
    },
    [containerRef, onPan, onZoom]
  )

  const handleTouchEnd = useCallback((e: TouchEvent) => {
    // Remove ended touches
    for (const touch of Array.from(e.changedTouches)) {
      activeTouches.current.delete(touch.identifier)
    }

    // Reset pinch state when fewer than 2 touches
    if (activeTouches.current.size < 2) {
      lastPinchDistance.current = null
      lastPinchCenter.current = null
    }

    // Update last position if still have one touch
    if (activeTouches.current.size === 1) {
      const touches = Array.from(activeTouches.current.values())
      lastPos.current = { x: touches[0].x, y: touches[0].y }
    }
  }, [])

  const handleTouchCancel = useCallback(() => {
    // Clear all touches on cancel
    activeTouches.current.clear()
    lastPinchDistance.current = null
    lastPinchCenter.current = null
  }, [])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    // Mouse events
    container.addEventListener(`mousedown`, handleMouseDown)
    window.addEventListener(`mousemove`, handleMouseMove)
    window.addEventListener(`mouseup`, handleMouseUp)
    container.addEventListener(`wheel`, handleWheel, { passive: false })

    // Touch events
    container.addEventListener(`touchstart`, handleTouchStart, {
      passive: false,
    })
    container.addEventListener(`touchmove`, handleTouchMove, { passive: false })
    container.addEventListener(`touchend`, handleTouchEnd)
    container.addEventListener(`touchcancel`, handleTouchCancel)

    return () => {
      container.removeEventListener(`mousedown`, handleMouseDown)
      window.removeEventListener(`mousemove`, handleMouseMove)
      window.removeEventListener(`mouseup`, handleMouseUp)
      container.removeEventListener(`wheel`, handleWheel)
      container.removeEventListener(`touchstart`, handleTouchStart)
      container.removeEventListener(`touchmove`, handleTouchMove)
      container.removeEventListener(`touchend`, handleTouchEnd)
      container.removeEventListener(`touchcancel`, handleTouchCancel)
    }
  }, [
    containerRef,
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
    handleWheel,
    handleTouchStart,
    handleTouchMove,
    handleTouchEnd,
    handleTouchCancel,
  ])

  return { setCurrentZoom }
}
