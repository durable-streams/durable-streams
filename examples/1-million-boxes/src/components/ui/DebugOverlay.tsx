import { useCallback, useEffect, useRef, useState } from "react"
import {
  getDebugConfig,
  setDebugConfig,
  subscribeDebugConfig,
} from "../../lib/debug-config"
import type { DebugConfig } from "../../lib/debug-config"
import "./DebugOverlay.css"

/**
 * Debug overlay showing FPS counter and rendering toggles.
 * Press 'D' to toggle debug mode.
 */
export function DebugOverlay() {
  const [config, setConfig] = useState<DebugConfig>(getDebugConfig)
  const [fps, setFps] = useState(0)
  const frameTimesRef = useRef<Array<number>>([])
  const lastTimeRef = useRef(performance.now())
  const rafIdRef = useRef<number>(0)

  // Subscribe to config changes
  useEffect(() => {
    return subscribeDebugConfig(setConfig)
  }, [])

  // FPS measurement
  useEffect(() => {
    if (!config.showFps) {
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current)
        rafIdRef.current = 0
      }
      return
    }

    const measureFps = () => {
      const now = performance.now()
      const delta = now - lastTimeRef.current
      lastTimeRef.current = now

      // Keep last 60 frame times
      frameTimesRef.current.push(delta)
      if (frameTimesRef.current.length > 60) {
        frameTimesRef.current.shift()
      }

      // Calculate average FPS
      const avgDelta =
        frameTimesRef.current.reduce((a, b) => a + b, 0) /
        frameTimesRef.current.length
      setFps(Math.round(1000 / avgDelta))

      rafIdRef.current = requestAnimationFrame(measureFps)
    }

    rafIdRef.current = requestAnimationFrame(measureFps)

    return () => {
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current)
      }
    }
  }, [config.showFps])

  // Keyboard shortcut: D to toggle debug mode
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === `d` || e.key === `D`) {
        // Don't trigger if typing in an input
        if (
          e.target instanceof HTMLInputElement ||
          e.target instanceof HTMLTextAreaElement
        ) {
          return
        }
        setDebugConfig({ showFps: !getDebugConfig().showFps })
      }
    }

    window.addEventListener(`keydown`, handleKeyDown)
    return () => window.removeEventListener(`keydown`, handleKeyDown)
  }, [])

  const handleToggle = useCallback(
    (key: keyof Omit<DebugConfig, `showFps`>) => {
      setDebugConfig({ [key]: !config[key] })
    },
    [config]
  )

  if (!config.showFps) {
    return null
  }

  return (
    <div className="debug-overlay">
      <div className="debug-fps">
        <span className="debug-fps-value">{fps}</span>
        <span className="debug-fps-label">FPS</span>
      </div>

      <div className="debug-toggles">
        <label className="debug-toggle">
          <input
            type="checkbox"
            checked={config.renderGridLines}
            onChange={() => handleToggle(`renderGridLines`)}
          />
          Grid Lines
        </label>
        <label className="debug-toggle">
          <input
            type="checkbox"
            checked={config.renderDots}
            onChange={() => handleToggle(`renderDots`)}
          />
          Dots
        </label>
        <label className="debug-toggle">
          <input
            type="checkbox"
            checked={config.renderDrawnLines}
            onChange={() => handleToggle(`renderDrawnLines`)}
          />
          Drawn Lines
        </label>
        <label className="debug-toggle">
          <input
            type="checkbox"
            checked={config.renderShadedBoxes}
            onChange={() => handleToggle(`renderShadedBoxes`)}
          />
          Shaded Boxes
        </label>
      </div>

      <div className="debug-hint">Press D to close</div>
    </div>
  )
}
