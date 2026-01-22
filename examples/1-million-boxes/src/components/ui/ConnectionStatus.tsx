import { useGameStateContext } from "../../contexts/game-state-context"
import "./ConnectionStatus.css"

/**
 * Shows connection status when loading or disconnected.
 * Hidden when connected.
 */
export function ConnectionStatus() {
  const { isLoading, isConnected } = useGameStateContext()

  if (isConnected && !isLoading) {
    return null
  }

  return (
    <div className="connection-status" data-testid="connection-status">
      {isLoading ? (
        <div className="connection-status__loading">
          <span className="connection-status__spinner" />
          <span>Loading game...</span>
        </div>
      ) : (
        <div className="connection-status__disconnected">
          <span className="connection-status__dot" />
          <span>Reconnecting...</span>
        </div>
      )}
    </div>
  )
}
