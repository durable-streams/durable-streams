import { useEffect, useRef, useState } from "react"
import * as Y from "yjs"
import { Awareness } from "y-protocols/awareness"
import { YjsProvider } from "@durable-streams/y-durable-streams"
import { ROOM_TTL_SECONDS } from "../utils/schemas"
import { GameRoomContext } from "./game-room-context"
import { ScoresProvider } from "./scores-context"
import { useRegistryContext } from "./registry-context"
import { SnakeGame } from "./SnakeGame"
import type { YjsProviderStatus } from "@durable-streams/y-durable-streams"
import type { GameRoomContextValue } from "./game-room-context"

// ============================================================================
// Player colors
// ============================================================================

// Avoid #FF6B35 (obstacle solid) and #FFD93D (obstacle warning)
const PLAYER_COLORS = [
  `#00E5FF`,
  `#FF3D71`,
  `#6eeb83`,
  `#ffbc42`,
  `#ee6352`,
  `#9ac2c9`,
  `#8acb88`,
  `#1be7ff`,
  `#C77DFF`,
  `#72EFDD`,
  `#F72585`,
  `#4ECDC4`,
]

function getColor(index: number): string {
  return PLAYER_COLORS[index % PLAYER_COLORS.length]
}

// ============================================================================
// GameRoom component
// ============================================================================

interface GameRoomProps {
  roomId: string
  yjsBaseUrl: string
  yjsHeaders?: Record<string, string>
  playerName: string
  onLeave: () => void
}

export function GameRoom({
  roomId,
  yjsBaseUrl,
  yjsHeaders,
  playerName,
  onLeave,
}: GameRoomProps) {
  const { registryDB } = useRegistryContext()

  const [{ playerId, playerColor }] = useState(() => {
    const id = `player-${Math.random().toString(36).slice(2, 10)}`
    const colorIdx = Math.floor(Math.random() * PLAYER_COLORS.length)
    return { playerId: id, playerColor: getColor(colorIdx) }
  })

  const [{ doc, awareness }] = useState(() => {
    const d = new Y.Doc()
    const a = new Awareness(d)
    a.setLocalState({
      user: { name: playerName, color: playerColor },
      playerId,
    })
    return { doc: d, awareness: a }
  })

  const [isLoading, setIsLoading] = useState(true)
  const [isSynced, setIsSynced] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const providerRef = useRef<YjsProvider | null>(null)

  useEffect(() => {
    const provider = new YjsProvider({
      doc,
      baseUrl: yjsBaseUrl,
      docId: roomId,
      awareness,
      headers: yjsHeaders,
      connect: false,
    })

    provider.on(`synced`, (synced: boolean) => {
      setIsSynced(synced)
      if (synced) setIsLoading(false)
    })

    provider.on(`status`, (status: YjsProviderStatus) => {
      if (status === `connected`) setIsLoading(false)
    })

    provider.on(`error`, (err: Error) => {
      setError(err)
      setIsLoading(false)
    })

    // Re-set awareness in case React Strict Mode cleared it
    if (awareness.getLocalState() === null) {
      awareness.setLocalState({
        user: { name: playerName, color: playerColor },
        playerId,
      })
    }

    providerRef.current = provider
    provider.connect()

    return () => {
      provider.destroy()
      providerRef.current = null
    }
  }, [
    roomId,
    doc,
    awareness,
    yjsBaseUrl,
    yjsHeaders,
    playerName,
    playerColor,
    playerId,
  ])

  // Broadcast player count to registry when awareness changes
  const lastCountRef = useRef(-1)
  useEffect(() => {
    const updatePlayerCount = () => {
      const count = awareness.getStates().size
      if (count === lastCountRef.current) return
      lastCountRef.current = count

      // Look up existing room metadata to preserve fields (especially expiresAt)
      const rooms = registryDB.collections.rooms.toArray
      const existing = rooms.find((r) => r.roomId === roomId)

      if (existing) {
        try {
          registryDB.actions.addRoom({ ...existing, playerCount: count })
        } catch {
          /* best-effort */
        }
      } else {
        // Fallback: reconstruct metadata from roomId
        const nameMatch = roomId.match(/^(.+?)__/)
        const name = nameMatch ? nameMatch[1] : roomId
        const sizeMatch = roomId.match(/__(\d+x\d+)/)
        const speedMatch = roomId.match(/__\d+x\d+_(\d+)ms/)
        const boardSize = sizeMatch ? sizeMatch[1] : `30x24`
        const speedLabel = speedMatch
          ? ({ "220": `Chill`, "180": `Normal`, "120": `Fast`, "80": `Insane` }[
              speedMatch[1]
            ] ?? ``)
          : ``
        const boardSizeDisplay = speedLabel
          ? `${boardSize} · ${speedLabel}`
          : boardSize
        const now = Date.now()
        try {
          registryDB.actions.addRoom({
            roomId,
            name,
            boardSize: boardSizeDisplay,
            createdAt: now,
            expiresAt: now + ROOM_TTL_SECONDS * 1000,
            playerCount: count,
          })
        } catch {
          /* best-effort */
        }
      }
    }
    awareness.on(`change`, updatePlayerCount)
    // Initial broadcast after a short delay to let awareness sync
    const timeout = setTimeout(updatePlayerCount, 1000)
    return () => {
      awareness.off(`change`, updatePlayerCount)
      clearTimeout(timeout)
    }
  }, [awareness, registryDB, roomId])

  // Clean up doc on unmount
  useEffect(() => {
    return () => {
      doc.destroy()
    }
  }, [doc])

  if (error) {
    return (
      <div style={styles.center}>
        <div style={{ color: `#FF3D71`, fontSize: 14 }}>
          Connection error: {error.message}
        </div>
        <button onClick={onLeave} style={styles.btn}>
          Back to Lobby
        </button>
      </div>
    )
  }

  if (isLoading) {
    return (
      <div style={styles.center}>
        <div style={{ color: `#8892B0`, fontSize: 14 }}>
          Connecting to room...
        </div>
      </div>
    )
  }

  // Get expiresAt from registry (or default to 10 min from now)
  const roomEntry = registryDB.collections.rooms.toArray.find(
    (r) => r.roomId === roomId
  )
  const expiresAt = roomEntry?.expiresAt ?? Date.now() + ROOM_TTL_SECONDS * 1000

  const value: GameRoomContextValue = {
    doc,
    awareness,
    roomId,
    playerId,
    playerName,
    playerColor,
    isSynced,
    isLoading,
    expiresAt,
  }

  return (
    <GameRoomContext.Provider value={value}>
      <ScoresProvider roomId={roomId}>
        <SnakeGame onLeave={onLeave} />
      </ScoresProvider>
    </GameRoomContext.Provider>
  )
}

const styles = {
  center: {
    display: `flex`,
    flexDirection: `column` as const,
    alignItems: `center`,
    justifyContent: `center`,
    height: `100vh`,
    gap: 16,
    fontFamily: `'JetBrains Mono', monospace`,
    background: `#0B0E17`,
  },
  btn: {
    fontFamily: `inherit`,
    fontSize: 12,
    padding: `8px 24px`,
    background: `#00E5FF`,
    color: `#000`,
    border: `none`,
    cursor: `pointer`,
    borderRadius: 4,
    fontWeight: 700,
  },
}
