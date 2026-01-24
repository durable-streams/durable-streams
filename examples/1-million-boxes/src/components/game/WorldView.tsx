import { useCallback, useEffect, useMemo, useRef } from "react"
import { W, edgeIdToCoords } from "../../lib/edge-math"
import { useViewStateContext } from "../../hooks/useViewState"
import { useGameStateContext } from "../../contexts/game-state-context"
import { TEAMS, TEAM_COLORS } from "../../lib/teams"
import { MinimapRenderer } from "./MinimapRenderer"
import "./WorldView.css"

const MINIMAP_SIZE = 150
const POP_DURATION = 800 // ms - should match CSS animation

export function WorldView() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const rendererRef = useRef<MinimapRenderer | null>(null)
  const { boxBitmap, version, recentEvents } = useGameStateContext()
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

    // Render using shared bitmap
    renderer.render(boxBitmap)

    // Draw viewport rectangle if we have canvas size
    if (canvasSize.width > 0 && canvasSize.height > 0) {
      renderer.drawViewport(view, canvasSize.width, canvasSize.height)
    }
  }, [boxBitmap, version, view, canvasSize])

  // Handle click to navigate
  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const container = containerRef.current
      if (!container) return

      const rect = container.getBoundingClientRect()
      const clickX = e.clientX - rect.left
      const clickY = e.clientY - rect.top

      // Convert minimap coordinates to world coordinates
      const displayedWidth = rect.width
      const displayedHeight = rect.height
      const worldX = (clickX / displayedWidth) * W
      const worldY = (clickY / displayedHeight) * W

      jumpTo(worldX, worldY)
    },
    [jumpTo]
  )

  // Calculate pop positions from recent events
  const pops = useMemo(() => {
    const now = Date.now()
    return recentEvents
      .filter((e) => now - e.timestamp < POP_DURATION)
      .map((event) => {
        const coords = edgeIdToCoords(event.edgeId)
        // Get box center position from edge
        // For horizontal edges: box is at (x, y) or (x, y-1)
        // For vertical edges: box is at (x, y) or (x-1, y)
        const boxX = coords.horizontal ? coords.x + 0.5 : coords.x - 0.5
        const boxY = coords.horizontal ? coords.y - 0.5 : coords.y + 0.5

        // Convert to percentage position
        const xPercent = (boxX / W) * 100
        const yPercent = (boxY / W) * 100

        // Get team color (teamId is 0-based: 0=RED, 1=BLUE, 2=GREEN, 3=YELLOW)
        const teamName = TEAMS[event.teamId]
        const color = TEAM_COLORS[teamName].primary

        return {
          key: `${event.edgeId}-${event.timestamp}`,
          x: xPercent,
          y: yPercent,
          color,
          age: now - event.timestamp,
        }
      })
  }, [recentEvents])

  return (
    <div
      ref={containerRef}
      className="world-view-container"
      onClick={handleClick}
      data-testid="world-view"
    >
      <canvas ref={canvasRef} className="world-view-canvas" />
      {pops.map((pop) => (
        <div
          key={pop.key}
          className="world-view-pop"
          style={{
            left: `${pop.x}%`,
            top: `${pop.y}%`,
            backgroundColor: pop.color,
            animationDelay: `-${pop.age}ms`,
          }}
        />
      ))}
    </div>
  )
}
