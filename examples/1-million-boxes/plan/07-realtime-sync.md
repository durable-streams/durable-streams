# Phase 07: Real-time Sync

## Goal

Implement real-time synchronization: connect to Durable Streams via SSE, update game state as events arrive, and handle edge placement with optimistic updates.

## Dependencies

- Phase 02 (Core Game Logic)
- Phase 03 (Backend Server)
- Phase 05 (Canvas Rendering)

## Tasks

### 7.1 Game State Hook

Create `src/hooks/useGameState.ts`:

```typescript
import { useState, useCallback, useRef, useEffect } from "react"
import { GameState, GameEvent } from "../lib/game-state"
import { useQuota } from "../contexts/quota-context"
import { useTeam } from "../contexts/team-context"
import { drawEdge } from "../server/functions"

interface UseGameStateReturn {
  gameState: GameState
  pendingEdge: number | null
  isLoading: boolean
  error: string | null
  placeEdge: (edgeId: number) => Promise<void>
  applyEvents: (events: GameEvent[]) => void
}

export function useGameState(): UseGameStateReturn {
  const [gameState] = useState(() => new GameState())
  const [pendingEdge, setPendingEdge] = useState<number | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [, forceUpdate] = useState({})

  const { teamId } = useTeam()
  const { consume, refund } = useQuota()

  // Apply events from stream
  const applyEvents = useCallback(
    (events: GameEvent[]) => {
      for (const event of events) {
        gameState.applyEvent(event)
      }
      forceUpdate({}) // Trigger re-render
    },
    [gameState]
  )

  // Place an edge
  const placeEdge = useCallback(
    async (edgeId: number) => {
      // Check if edge is available
      if (gameState.isEdgeTaken(edgeId)) {
        setError("Edge already taken")
        return
      }

      // Check and consume quota
      if (!consume()) {
        setError("Out of lines - wait for recharge")
        return
      }

      // Set pending state
      setPendingEdge(edgeId)
      setError(null)

      try {
        const result = await drawEdge({ edgeId })

        if (result.ok) {
          // Success - state will be updated via SSE
          // Clear pending after a short delay to allow SSE to catch up
          setTimeout(() => setPendingEdge(null), 500)
        } else {
          // Failed - revert
          setPendingEdge(null)

          switch (result.code) {
            case "EDGE_TAKEN":
              // Refund quota since edge was already taken
              refund()
              setError("Edge was already taken")
              break
            case "RATE_LIMITED":
              // Don't refund - server says slow down
              setError("Too many requests - slow down")
              break
            case "WARMING_UP":
              refund()
              setError("Server is starting up - try again")
              break
            default:
              refund()
              setError("Failed to place edge")
          }
        }
      } catch (err) {
        setPendingEdge(null)
        refund()
        setError("Network error - try again")
      }
    },
    [gameState, consume, refund]
  )

  return {
    gameState,
    pendingEdge,
    isLoading,
    error,
    placeEdge,
    applyEvents,
  }
}
```

### 7.2 Game Stream Hook

Create `src/hooks/useGameStream.ts`:

```typescript
import { useEffect, useRef, useCallback } from "react"
import { StreamParser } from "../lib/stream-parser"
import { GameEvent } from "../lib/game-state"

interface UseGameStreamOptions {
  onEvents: (events: GameEvent[]) => void
  onError?: (error: Error) => void
  onConnected?: () => void
  onDisconnected?: () => void
}

export function useGameStream({
  onEvents,
  onError,
  onConnected,
  onDisconnected,
}: UseGameStreamOptions) {
  const parserRef = useRef(new StreamParser())
  const eventSourceRef = useRef<EventSource | null>(null)
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout>>()

  const connect = useCallback(() => {
    // Get stream URL from environment
    const streamUrl =
      import.meta.env.VITE_DURABLE_STREAMS_URL || "http://localhost:8787"
    const url = `${streamUrl}/streams/boxes/edges`

    // First, fetch existing data
    fetch(url)
      .then((res) => res.arrayBuffer())
      .then((buffer) => {
        const bytes = new Uint8Array(buffer)
        const events = parserRef.current.feed(bytes)
        if (events.length > 0) {
          onEvents(events)
        }

        // Then connect to SSE for live updates
        connectSSE(url)
      })
      .catch((err) => {
        onError?.(err)
        scheduleReconnect()
      })
  }, [onEvents, onError])

  const connectSSE = useCallback(
    (baseUrl: string) => {
      // Close existing connection
      if (eventSourceRef.current) {
        eventSourceRef.current.close()
      }

      // Connect to SSE endpoint
      const sseUrl = `${baseUrl}/subscribe`
      const eventSource = new EventSource(sseUrl)
      eventSourceRef.current = eventSource

      eventSource.onopen = () => {
        onConnected?.()
      }

      eventSource.onmessage = (event) => {
        try {
          // Assuming SSE sends base64-encoded binary data
          const binaryString = atob(event.data)
          const bytes = new Uint8Array(binaryString.length)
          for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i)
          }

          const events = parserRef.current.feed(bytes)
          if (events.length > 0) {
            onEvents(events)
          }
        } catch (err) {
          console.error("Failed to parse SSE message:", err)
        }
      }

      eventSource.onerror = () => {
        onDisconnected?.()
        eventSource.close()
        eventSourceRef.current = null
        scheduleReconnect()
      }
    },
    [onEvents, onConnected, onDisconnected]
  )

  const scheduleReconnect = useCallback(() => {
    clearTimeout(reconnectTimeoutRef.current)
    reconnectTimeoutRef.current = setTimeout(() => {
      connect()
    }, 3000)
  }, [connect])

  useEffect(() => {
    connect()

    return () => {
      clearTimeout(reconnectTimeoutRef.current)
      eventSourceRef.current?.close()
    }
  }, [connect])

  const disconnect = useCallback(() => {
    clearTimeout(reconnectTimeoutRef.current)
    eventSourceRef.current?.close()
    eventSourceRef.current = null
  }, [])

  return { disconnect, reconnect: connect }
}
```

### 7.3 Game State Context

Create `src/contexts/game-state-context.tsx`:

```typescript
import { createContext, useContext, ReactNode, useCallback, useState, useRef, useEffect } from 'react';
import { GameState, GameEvent } from '../lib/game-state';
import { useGameStream } from '../hooks/useGameStream';
import { useQuota } from './quota-context';
import { useTeam } from './team-context';
import { drawEdge } from '../server/functions';

interface GameStateContextValue {
  gameState: GameState;
  pendingEdge: number | null;
  isConnected: boolean;
  isLoading: boolean;
  error: string | null;
  placeEdge: (edgeId: number) => Promise<void>;
}

const GameStateContext = createContext<GameStateContextValue | null>(null);

export function GameStateProvider({ children }: { children: ReactNode }) {
  const gameStateRef = useRef(new GameState());
  const [pendingEdge, setPendingEdge] = useState<number | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0); // Force re-renders

  const { teamId } = useTeam();
  const { consume, refund } = useQuota();

  // Handle incoming events
  const handleEvents = useCallback((events: GameEvent[]) => {
    for (const event of events) {
      gameStateRef.current.applyEvent(event);
    }
    setVersion(v => v + 1);
    setIsLoading(false);

    // Clear pending edge if it was placed
    if (pendingEdge !== null) {
      const wasPending = events.some(e => e.edgeId === pendingEdge);
      if (wasPending) {
        setPendingEdge(null);
      }
    }
  }, [pendingEdge]);

  // Connect to stream
  useGameStream({
    onEvents: handleEvents,
    onConnected: () => setIsConnected(true),
    onDisconnected: () => setIsConnected(false),
    onError: (err) => {
      console.error('Stream error:', err);
      setError('Connection error');
    },
  });

  // Place an edge
  const placeEdge = useCallback(async (edgeId: number) => {
    const gameState = gameStateRef.current;

    // Check if edge is available
    if (gameState.isEdgeTaken(edgeId)) {
      setError('Edge already taken');
      setTimeout(() => setError(null), 2000);
      return;
    }

    // Check and consume quota
    if (!consume()) {
      setError('Out of lines - wait for recharge');
      setTimeout(() => setError(null), 2000);
      return;
    }

    // Set pending state
    setPendingEdge(edgeId);
    setError(null);

    try {
      const result = await drawEdge({ edgeId });

      if (!result.ok) {
        setPendingEdge(null);

        switch (result.code) {
          case 'EDGE_TAKEN':
            refund();
            setError('Edge was already taken');
            break;
          case 'RATE_LIMITED':
            setError('Too many requests - slow down');
            break;
          case 'WARMING_UP':
            refund();
            setError('Server is starting up - try again');
            break;
          default:
            refund();
            setError('Failed to place edge');
        }

        setTimeout(() => setError(null), 3000);
      }
      // On success, wait for SSE to confirm
    } catch (err) {
      setPendingEdge(null);
      refund();
      setError('Network error - try again');
      setTimeout(() => setError(null), 3000);
    }
  }, [consume, refund]);

  return (
    <GameStateContext.Provider value={{
      gameState: gameStateRef.current,
      pendingEdge,
      isConnected,
      isLoading,
      error,
      placeEdge,
    }}>
      {children}
    </GameStateContext.Provider>
  );
}

export function useGameStateContext(): GameStateContextValue {
  const ctx = useContext(GameStateContext);
  if (!ctx) {
    throw new Error('useGameStateContext must be used within GameStateProvider');
  }
  return ctx;
}
```

### 7.4 Update Root Route with Game State Provider

Update `src/routes/__root.tsx`:

```tsx
import { createRootRoute, Outlet } from "@tanstack/react-router"
import { getTeam } from "../server/functions"
import { TeamProvider } from "../contexts/team-context"
import { QuotaProvider } from "../contexts/quota-context"
import { GameStateProvider } from "../contexts/game-state-context"
import "../styles/global.css"

export const Route = createRootRoute({
  loader: async () => {
    const { team, teamId } = await getTeam()
    return { team, teamId }
  },
  component: RootComponent,
})

function RootComponent() {
  const { team, teamId } = Route.useLoaderData()

  return (
    <TeamProvider team={team} teamId={teamId}>
      <QuotaProvider>
        <GameStateProvider>
          <div className="app-container">
            <Outlet />
          </div>
        </GameStateProvider>
      </QuotaProvider>
    </TeamProvider>
  )
}
```

### 7.5 Update GameCanvas to Use Context

Update `src/components/game/GameCanvas.tsx` to use the game state context:

```tsx
import { useRef, useEffect, useCallback, useState } from "react"
import { useViewState } from "../../hooks/useViewState"
import { useGameStateContext } from "../../contexts/game-state-context"
import { usePanZoom } from "../../hooks/usePanZoom"
import { renderBoxes } from "./BoxRenderer"
import { renderEdges } from "./EdgeRenderer"
import { renderDots } from "./DotRenderer"
import { screenToWorld } from "../../lib/view-transform"
import { findNearestEdge } from "../../lib/edge-picker"
import "./GameCanvas.css"

export function GameCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const { view, pan, zoomTo } = useViewState()
  const { gameState, pendingEdge, placeEdge, error } = useGameStateContext()
  const [hoveredEdge, setHoveredEdge] = useState<number | null>(null)
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 })

  // ... rest of the implementation from Phase 05
  // Use placeEdge from context instead of local function

  // Show error toast
  useEffect(() => {
    if (error) {
      // Could use a toast library here
      console.warn("Game error:", error)
    }
  }, [error])

  // ... rest of component
}
```

### 7.6 Connection Status Indicator

Create `src/components/ui/ConnectionStatus.tsx`:

```tsx
import { useGameStateContext } from "../../contexts/game-state-context"
import "./ConnectionStatus.css"

export function ConnectionStatus() {
  const { isConnected, isLoading } = useGameStateContext()

  if (isLoading) {
    return (
      <div className="connection-status loading">
        <span className="status-dot" />
        Loading...
      </div>
    )
  }

  if (!isConnected) {
    return (
      <div className="connection-status disconnected">
        <span className="status-dot" />
        Reconnecting...
      </div>
    )
  }

  return null // Don't show when connected
}
```

Create `src/components/ui/ConnectionStatus.css`:

```css
.connection-status {
  position: fixed;
  top: calc(var(--header-height) + 8px);
  left: 50%;
  transform: translateX(-50%);
  padding: 8px 16px;
  border-radius: 20px;
  font-size: 12px;
  font-weight: 500;
  display: flex;
  align-items: center;
  gap: 8px;
  z-index: 50;
}

.connection-status.loading {
  background: #fff3cd;
  color: #856404;
}

.connection-status.disconnected {
  background: #f8d7da;
  color: #721c24;
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  animation: pulse 1.5s infinite;
}

.loading .status-dot {
  background: #ffc107;
}

.disconnected .status-dot {
  background: #dc3545;
}
```

### 7.7 Error Toast Component

Create `src/components/ui/ErrorToast.tsx`:

```tsx
import { useGameStateContext } from "../../contexts/game-state-context"
import "./ErrorToast.css"

export function ErrorToast() {
  const { error } = useGameStateContext()

  if (!error) return null

  return (
    <div className="error-toast" role="alert">
      {error}
    </div>
  )
}
```

Create `src/components/ui/ErrorToast.css`:

```css
.error-toast {
  position: fixed;
  bottom: calc(var(--footer-height) + 16px);
  left: 50%;
  transform: translateX(-50%);
  padding: 12px 20px;
  background: #f8d7da;
  color: #721c24;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 500;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  z-index: 50;
  animation: slideUp 0.3s ease;
}

@keyframes slideUp {
  from {
    opacity: 0;
    transform: translateX(-50%) translateY(20px);
  }
  to {
    opacity: 1;
    transform: translateX(-50%) translateY(0);
  }
}
```

## Deliverables

- [ ] `src/hooks/useGameStream.ts` — SSE connection hook
- [ ] `src/contexts/game-state-context.tsx` — Game state context
- [ ] Updated root route with GameStateProvider
- [ ] Updated GameCanvas to use context
- [ ] `ConnectionStatus` component
- [ ] `ErrorToast` component
- [ ] Real-time updates working
- [ ] Optimistic edge placement
- [ ] Error handling with user feedback

## Next Phase

→ `08-world-view.md`
