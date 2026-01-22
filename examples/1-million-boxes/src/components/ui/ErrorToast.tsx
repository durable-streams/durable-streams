import { useEffect, useState } from "react"
import { useGameStateContext } from "../../contexts/game-state-context"
import "./ErrorToast.css"

const TOAST_DURATION_MS = 4000

/**
 * Shows error messages from game state.
 * Positioned at the bottom above the footer.
 */
export function ErrorToast() {
  const { error } = useGameStateContext()
  const [visible, setVisible] = useState(false)
  const [displayedError, setDisplayedError] = useState<string | null>(null)

  useEffect(() => {
    if (error) {
      setDisplayedError(error)
      setVisible(true)

      const timer = setTimeout(() => {
        setVisible(false)
      }, TOAST_DURATION_MS)

      return () => clearTimeout(timer)
    }
  }, [error])

  // Handle animation end to clear displayed error
  const handleAnimationEnd = () => {
    if (!visible) {
      setDisplayedError(null)
    }
  }

  if (!displayedError) {
    return null
  }

  return (
    <div
      className={`error-toast ${visible ? `error-toast--visible` : `error-toast--hidden`}`}
      onAnimationEnd={handleAnimationEnd}
      data-testid="error-toast"
    >
      <span className="error-toast__icon">!</span>
      <span className="error-toast__message">{displayedError}</span>
    </div>
  )
}
