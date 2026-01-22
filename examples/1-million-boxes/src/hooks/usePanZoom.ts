import { useCallback, useEffect, useRef } from "react"
import type { RefObject } from "react"

interface PanZoomOptions {
  onPan: (deltaX: number, deltaY: number) => void
  onZoom: (newZoom: number, focalX?: number, focalY?: number) => void
}

/**
 * Hook to handle pan and zoom interactions on an element.
 * Supports mouse drag for panning and mouse wheel for zooming.
 */
export function usePanZoom(
  containerRef: RefObject<HTMLElement | null>,
  options: PanZoomOptions
) {
  const { onPan, onZoom } = options
  const isPanning = useRef(false)
  const lastPos = useRef({ x: 0, y: 0 })
  const currentZoom = useRef(1)

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

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    container.addEventListener(`mousedown`, handleMouseDown)
    window.addEventListener(`mousemove`, handleMouseMove)
    window.addEventListener(`mouseup`, handleMouseUp)
    container.addEventListener(`wheel`, handleWheel, { passive: false })

    return () => {
      container.removeEventListener(`mousedown`, handleMouseDown)
      window.removeEventListener(`mousemove`, handleMouseMove)
      window.removeEventListener(`mouseup`, handleMouseUp)
      container.removeEventListener(`wheel`, handleWheel)
    }
  }, [
    containerRef,
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
    handleWheel,
  ])
}
