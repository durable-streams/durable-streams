# Phase 09: Mobile Support

## Goal

Implement full mobile support: touch gestures for pan/zoom, responsive layout, and optimized touch targets.

## Dependencies

- Phase 05 (Canvas Rendering)
- Phase 06 (UI Components)
- Phase 08 (World View)

## Tasks

### 9.1 Pan/Zoom Gesture Hook

Create `src/hooks/usePanZoom.ts`:

```typescript
import { RefObject, useEffect, useRef, useCallback } from "react"

interface PanZoomOptions {
  onPan: (deltaX: number, deltaY: number) => void
  onZoom: (newZoom: number, focalX?: number, focalY?: number) => void
  minZoom?: number
  maxZoom?: number
}

interface TouchPoint {
  id: number
  x: number
  y: number
}

export function usePanZoom(
  containerRef: RefObject<HTMLElement>,
  { onPan, onZoom, minZoom = 0.1, maxZoom = 10 }: PanZoomOptions
) {
  const touchesRef = useRef<Map<number, TouchPoint>>(new Map())
  const lastPinchDistRef = useRef<number | null>(null)
  const lastPinchCenterRef = useRef<{ x: number; y: number } | null>(null)
  const isPanningRef = useRef(false)
  const lastPanPosRef = useRef<{ x: number; y: number } | null>(null)
  const currentZoomRef = useRef(1)

  // Mouse wheel zoom
  const handleWheel = useCallback(
    (e: WheelEvent) => {
      e.preventDefault()

      const container = containerRef.current
      if (!container) return

      const rect = container.getBoundingClientRect()
      const focalX = e.clientX - rect.left
      const focalY = e.clientY - rect.top

      // Determine zoom direction and amount
      const delta = -e.deltaY * 0.001
      const factor = 1 + delta
      const newZoom = Math.max(
        minZoom,
        Math.min(maxZoom, currentZoomRef.current * factor)
      )

      currentZoomRef.current = newZoom
      onZoom(newZoom, focalX, focalY)
    },
    [onZoom, minZoom, maxZoom, containerRef]
  )

  // Mouse drag pan
  const handleMouseDown = useCallback(
    (e: MouseEvent) => {
      if (e.button !== 0) return // Only left click

      isPanningRef.current = true
      lastPanPosRef.current = { x: e.clientX, y: e.clientY }

      const container = containerRef.current
      if (container) {
        container.style.cursor = "grabbing"
      }
    },
    [containerRef]
  )

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!isPanningRef.current || !lastPanPosRef.current) return

      const deltaX = e.clientX - lastPanPosRef.current.x
      const deltaY = e.clientY - lastPanPosRef.current.y

      onPan(deltaX, deltaY)

      lastPanPosRef.current = { x: e.clientX, y: e.clientY }
    },
    [onPan]
  )

  const handleMouseUp = useCallback(() => {
    isPanningRef.current = false
    lastPanPosRef.current = null

    const container = containerRef.current
    if (container) {
      container.style.cursor = "crosshair"
    }
  }, [containerRef])

  // Touch handlers
  const handleTouchStart = useCallback((e: TouchEvent) => {
    e.preventDefault()

    for (const touch of Array.from(e.changedTouches)) {
      touchesRef.current.set(touch.identifier, {
        id: touch.identifier,
        x: touch.clientX,
        y: touch.clientY,
      })
    }

    if (touchesRef.current.size === 1) {
      // Single touch - pan
      const touch = Array.from(touchesRef.current.values())[0]
      lastPanPosRef.current = { x: touch.x, y: touch.y }
    } else if (touchesRef.current.size === 2) {
      // Two touches - pinch zoom
      const touches = Array.from(touchesRef.current.values())
      lastPinchDistRef.current = getDistance(touches[0], touches[1])
      lastPinchCenterRef.current = getCenter(touches[0], touches[1])
    }
  }, [])

  const handleTouchMove = useCallback(
    (e: TouchEvent) => {
      e.preventDefault()

      // Update touch positions
      for (const touch of Array.from(e.changedTouches)) {
        if (touchesRef.current.has(touch.identifier)) {
          touchesRef.current.set(touch.identifier, {
            id: touch.identifier,
            x: touch.clientX,
            y: touch.clientY,
          })
        }
      }

      const touches = Array.from(touchesRef.current.values())

      if (touches.length === 1) {
        // Single touch pan
        const touch = touches[0]
        if (lastPanPosRef.current) {
          const deltaX = touch.x - lastPanPosRef.current.x
          const deltaY = touch.y - lastPanPosRef.current.y
          onPan(deltaX, deltaY)
        }
        lastPanPosRef.current = { x: touch.x, y: touch.y }
      } else if (touches.length === 2) {
        // Pinch zoom
        const dist = getDistance(touches[0], touches[1])
        const center = getCenter(touches[0], touches[1])

        if (lastPinchDistRef.current !== null) {
          const scaleFactor = dist / lastPinchDistRef.current
          const newZoom = Math.max(
            minZoom,
            Math.min(maxZoom, currentZoomRef.current * scaleFactor)
          )

          const container = containerRef.current
          if (container) {
            const rect = container.getBoundingClientRect()
            const focalX = center.x - rect.left
            const focalY = center.y - rect.top

            currentZoomRef.current = newZoom
            onZoom(newZoom, focalX, focalY)
          }
        }

        // Also pan with pinch
        if (lastPinchCenterRef.current) {
          const deltaX = center.x - lastPinchCenterRef.current.x
          const deltaY = center.y - lastPinchCenterRef.current.y
          onPan(deltaX, deltaY)
        }

        lastPinchDistRef.current = dist
        lastPinchCenterRef.current = center
      }
    },
    [onPan, onZoom, minZoom, maxZoom, containerRef]
  )

  const handleTouchEnd = useCallback((e: TouchEvent) => {
    for (const touch of Array.from(e.changedTouches)) {
      touchesRef.current.delete(touch.identifier)
    }

    if (touchesRef.current.size === 0) {
      lastPanPosRef.current = null
      lastPinchDistRef.current = null
      lastPinchCenterRef.current = null
    } else if (touchesRef.current.size === 1) {
      // Switch from pinch to pan
      const touch = Array.from(touchesRef.current.values())[0]
      lastPanPosRef.current = { x: touch.x, y: touch.y }
      lastPinchDistRef.current = null
      lastPinchCenterRef.current = null
    }
  }, [])

  // Double tap to zoom
  const lastTapRef = useRef<{ time: number; x: number; y: number } | null>(null)

  const handleTap = useCallback(
    (x: number, y: number) => {
      const now = Date.now()

      if (lastTapRef.current) {
        const timeDiff = now - lastTapRef.current.time
        const distDiff = Math.sqrt(
          Math.pow(x - lastTapRef.current.x, 2) +
            Math.pow(y - lastTapRef.current.y, 2)
        )

        if (timeDiff < 300 && distDiff < 30) {
          // Double tap - zoom in
          const container = containerRef.current
          if (container) {
            const rect = container.getBoundingClientRect()
            const newZoom = Math.min(maxZoom, currentZoomRef.current * 2)
            currentZoomRef.current = newZoom
            onZoom(newZoom, x - rect.left, y - rect.top)
          }
          lastTapRef.current = null
          return
        }
      }

      lastTapRef.current = { time: now, x, y }
    },
    [onZoom, maxZoom, containerRef]
  )

  // Attach event listeners
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    // Mouse events
    container.addEventListener("wheel", handleWheel, { passive: false })
    container.addEventListener("mousedown", handleMouseDown)
    window.addEventListener("mousemove", handleMouseMove)
    window.addEventListener("mouseup", handleMouseUp)

    // Touch events
    container.addEventListener("touchstart", handleTouchStart, {
      passive: false,
    })
    container.addEventListener("touchmove", handleTouchMove, { passive: false })
    container.addEventListener("touchend", handleTouchEnd)
    container.addEventListener("touchcancel", handleTouchEnd)

    return () => {
      container.removeEventListener("wheel", handleWheel)
      container.removeEventListener("mousedown", handleMouseDown)
      window.removeEventListener("mousemove", handleMouseMove)
      window.removeEventListener("mouseup", handleMouseUp)

      container.removeEventListener("touchstart", handleTouchStart)
      container.removeEventListener("touchmove", handleTouchMove)
      container.removeEventListener("touchend", handleTouchEnd)
      container.removeEventListener("touchcancel", handleTouchEnd)
    }
  }, [
    handleWheel,
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
    handleTouchStart,
    handleTouchMove,
    handleTouchEnd,
    containerRef,
  ])

  // Update current zoom when it changes externally
  const setCurrentZoom = useCallback((zoom: number) => {
    currentZoomRef.current = zoom
  }, [])

  return { setCurrentZoom }
}

function getDistance(p1: TouchPoint, p2: TouchPoint): number {
  return Math.sqrt(Math.pow(p2.x - p1.x, 2) + Math.pow(p2.y - p1.y, 2))
}

function getCenter(p1: TouchPoint, p2: TouchPoint): { x: number; y: number } {
  return {
    x: (p1.x + p2.x) / 2,
    y: (p1.y + p2.y) / 2,
  }
}
```

### 9.2 Touch-Friendly Edge Selection

Update edge picker for touch with larger hit areas:

Update `src/lib/edge-picker.ts`:

```typescript
import { coordsToEdgeId, W, H, HORIZ_COUNT, isValidEdgeId } from "./edge-math"

interface EdgePickResult {
  edgeId: number
  distance: number
}

// Find the nearest edge to a world coordinate
export function findNearestEdge(
  worldX: number,
  worldY: number,
  zoom: number,
  isTouchDevice: boolean = false
): number | null {
  // Adjust hit radius based on zoom and input type
  const baseRadius = isTouchDevice ? 0.4 : 0.25
  const hitRadius = Math.min(0.5, baseRadius / Math.sqrt(zoom / 5))

  // Only pick edges if zoomed in enough
  const minZoom = isTouchDevice ? 3 : 5
  if (zoom < minZoom) return null

  const candidates: EdgePickResult[] = []

  // Check nearby horizontal edges
  const nearestHorizY = Math.round(worldY)
  for (let xOffset = -1; xOffset <= 1; xOffset++) {
    const x = Math.floor(worldX) + xOffset
    if (x >= 0 && x < W && nearestHorizY >= 0 && nearestHorizY <= H) {
      // Distance from edge center
      const edgeCenterX = x + 0.5
      const edgeCenterY = nearestHorizY
      const dist = Math.sqrt(
        Math.pow(worldX - edgeCenterX, 2) + Math.pow(worldY - edgeCenterY, 2)
      )

      if (dist < hitRadius) {
        candidates.push({
          edgeId: coordsToEdgeId(x, nearestHorizY, true),
          distance: dist,
        })
      }
    }
  }

  // Check nearby vertical edges
  const nearestVertX = Math.round(worldX)
  for (let yOffset = -1; yOffset <= 1; yOffset++) {
    const y = Math.floor(worldY) + yOffset
    if (nearestVertX >= 0 && nearestVertX <= W && y >= 0 && y < H) {
      const edgeCenterX = nearestVertX
      const edgeCenterY = y + 0.5
      const dist = Math.sqrt(
        Math.pow(worldX - edgeCenterX, 2) + Math.pow(worldY - edgeCenterY, 2)
      )

      if (dist < hitRadius) {
        candidates.push({
          edgeId: coordsToEdgeId(nearestVertX, y, false),
          distance: dist,
        })
      }
    }
  }

  // Return closest valid edge
  if (candidates.length === 0) return null

  candidates.sort((a, b) => a.distance - b.distance)
  const closest = candidates[0]

  return isValidEdgeId(closest.edgeId) ? closest.edgeId : null
}

// Detect touch device
export function isTouchDevice(): boolean {
  return "ontouchstart" in window || navigator.maxTouchPoints > 0
}
```

### 9.3 Responsive Layout CSS

Update `src/styles/mobile.css`:

```css
/* Mobile-first responsive styles */

/* Base mobile styles */
@media (max-width: 640px) {
  :root {
    --header-height: 44px;
    --footer-height: 52px;
    --minimap-size: 100px;
    --minimap-margin: 8px;
  }

  .header {
    padding: 0 8px;
    gap: 8px;
  }

  .footer {
    padding: 0 8px;
    flex-wrap: wrap;
    justify-content: center;
    gap: 8px;
  }

  .team-badge {
    padding: 4px 8px;
  }

  .team-badge .team-name {
    font-size: 12px;
  }

  .scoreboard {
    font-size: 12px;
    gap: 8px;
  }

  .score-item {
    gap: 2px;
  }

  .score-color {
    width: 10px;
    height: 10px;
  }

  .quota-meter {
    flex: 1;
    min-width: 100px;
  }

  .quota-segments {
    display: none; /* Hide on mobile to save space */
  }

  .zoom-controls {
    flex-shrink: 0;
  }

  .zoom-level {
    display: none; /* Hide percentage on mobile */
  }

  /* Larger touch targets */
  .zoom-btn {
    width: 48px;
    height: 48px;
    font-size: 24px;
  }

  /* World view positioning */
  .world-view {
    width: 100px;
    height: 100px;
  }

  /* Share button */
  .share-btn {
    padding: 6px 12px;
    font-size: 12px;
  }

  /* Dialog adjustments */
  .dialog-popup {
    width: 95%;
    padding: 16px;
  }

  .share-input-group {
    flex-direction: column;
  }

  .share-copy-btn {
    width: 100%;
  }
}

/* Tablet styles */
@media (min-width: 641px) and (max-width: 1024px) {
  :root {
    --minimap-size: 120px;
  }

  .header {
    padding: 0 12px;
  }

  .footer {
    padding: 0 12px;
  }
}

/* Landscape phone */
@media (max-width: 896px) and (orientation: landscape) {
  :root {
    --header-height: 40px;
    --footer-height: 44px;
    --minimap-size: 80px;
  }

  .scoreboard {
    display: none; /* Hide on landscape phone to save space */
  }

  .world-view {
    width: 80px;
    height: 80px;
  }
}

/* Safe area insets for notched devices */
@supports (padding: max(0px)) {
  .header {
    padding-top: max(0px, env(safe-area-inset-top));
    padding-left: max(8px, env(safe-area-inset-left));
    padding-right: max(8px, env(safe-area-inset-right));
  }

  .footer {
    padding-bottom: max(0px, env(safe-area-inset-bottom));
    padding-left: max(8px, env(safe-area-inset-left));
    padding-right: max(8px, env(safe-area-inset-right));
  }

  .world-view {
    right: max(var(--minimap-margin), env(safe-area-inset-right));
  }
}

/* Prevent text selection on touch */
.game-canvas-container {
  -webkit-user-select: none;
  user-select: none;
  -webkit-touch-callout: none;
}

/* Prevent pull-to-refresh */
html,
body {
  overscroll-behavior: none;
}

/* Hide scrollbars */
body {
  overflow: hidden;
}
```

### 9.4 Update Global CSS with Viewport Meta

Update `index.html`:

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta
      name="viewport"
      content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover"
    />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-status-bar-style" content="default" />
    <meta name="theme-color" content="#F5F5DC" />
    <title>1 Million Boxes</title>
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

### 9.5 Touch Feedback Component

Create `src/components/ui/TouchFeedback.tsx`:

```tsx
import { useState, useEffect, useCallback } from "react"
import "./TouchFeedback.css"

interface Ripple {
  id: number
  x: number
  y: number
}

export function useTouchFeedback() {
  const [ripples, setRipples] = useState<Ripple[]>([])

  const addRipple = useCallback((x: number, y: number) => {
    const id = Date.now()
    setRipples((r) => [...r, { id, x, y }])

    setTimeout(() => {
      setRipples((r) => r.filter((ripple) => ripple.id !== id))
    }, 600)
  }, [])

  return { ripples, addRipple }
}

export function TouchFeedback({ ripples }: { ripples: Ripple[] }) {
  return (
    <>
      {ripples.map((ripple) => (
        <div
          key={ripple.id}
          className="touch-ripple"
          style={{
            left: ripple.x,
            top: ripple.y,
          }}
        />
      ))}
    </>
  )
}
```

Create `src/components/ui/TouchFeedback.css`:

```css
.touch-ripple {
  position: fixed;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.1);
  transform: translate(-50%, -50%) scale(0);
  animation: ripple 0.6s ease-out forwards;
  pointer-events: none;
  z-index: 100;
}

@keyframes ripple {
  0% {
    transform: translate(-50%, -50%) scale(0);
    opacity: 1;
  }
  100% {
    transform: translate(-50%, -50%) scale(3);
    opacity: 0;
  }
}
```

### 9.6 Edge Placement Feedback

Update canvas to show feedback when placing edges:

Add to `GameCanvas.tsx`:

```tsx
// Add haptic feedback on edge placement (if supported)
const triggerHaptic = useCallback(() => {
  if ("vibrate" in navigator) {
    navigator.vibrate(10) // Short vibration
  }
}, [])

// In handleClick:
const handleClick = useCallback(
  (e: React.MouseEvent | React.TouchEvent) => {
    if (hoveredEdge !== null && !gameState.isEdgeTaken(hoveredEdge)) {
      triggerHaptic()
      placeEdge(hoveredEdge)
    }
  },
  [hoveredEdge, gameState, placeEdge, triggerHaptic]
)
```

## Deliverables

- [ ] `src/hooks/usePanZoom.ts` — Touch gesture handling
- [ ] Updated `edge-picker.ts` with touch-friendly hit areas
- [ ] `src/styles/mobile.css` — Responsive styles
- [ ] Safe area inset handling
- [ ] Touch feedback component
- [ ] Haptic feedback on edge placement
- [ ] Pinch-to-zoom works smoothly
- [ ] Pan with drag works
- [ ] Double-tap to zoom works
- [ ] All UI elements have 44px+ touch targets

## Next Phase

→ `10-testing.md`
