import { useEffect, useMemo, useRef, useState } from "react"
import * as Y from "yjs"
import { Awareness } from "y-protocols/awareness"
import { YjsProvider } from "@durable-streams/y-durable-streams"
import { ROOM_TTL_RENEWAL_MS, ROOM_TTL_SECONDS } from "../utils/schemas"
import { GameRoomContext } from "./game-room-context"
import { ScoresProvider } from "./scores-context"
import { useRegistryContext } from "./registry-context"
import { TerritoryGame } from "./TerritoryGame"
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

function hashName(name: string): number {
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0
  }
  return Math.abs(hash)
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
    const colorIdx = hashName(playerName)
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

  // Renew room TTL periodically so active rooms don't expire.
  // Only the elected writer (lowest playerId) performs the renewal.
  useEffect(() => {
    const renewTTL = () => {
      const playerIdSet = new Set<string>([playerId])
      awareness.getStates().forEach((state) => {
        if (state.playerId) playerIdSet.add(state.playerId as string)
      })
      const allPlayerIds = [...playerIdSet].sort()
      if (allPlayerIds[0] !== playerId) return

      const existing = registryDB.collections.rooms.toArray.find(
        (r) => r.roomId === roomId
      )
      if (existing) {
        try {
          registryDB.actions.addRoom({
            ...existing,
            expiresAt: Date.now() + ROOM_TTL_SECONDS * 1000,
          })
        } catch {
          /* best-effort */
        }
      }
    }
    const interval = setInterval(renewTTL, ROOM_TTL_RENEWAL_MS)
    return () => clearInterval(interval)
  }, [awareness, registryDB, roomId, playerId])

  // Clean up doc on unmount
  useEffect(() => {
    return () => {
      doc.destroy()
    }
  }, [doc])

  const value = useMemo<GameRoomContextValue>(
    () => ({
      doc,
      awareness,
      roomId,
      playerId,
      playerName,
      playerColor,
      isSynced,
      isLoading,
    }),
    [
      doc,
      awareness,
      roomId,
      playerId,
      playerName,
      playerColor,
      isSynced,
      isLoading,
    ]
  )

  if (error) {
    return (
      <div style={styles.center}>
        <div style={{ color: `#FF3D71`, fontSize: 8 }}>
          Connection error: {error.message}
        </div>
        <button onClick={onLeave} style={styles.btn}>
          BACK
        </button>
      </div>
    )
  }

  if (isLoading) {
    return (
      <div style={styles.center}>
        <style>{`@import url('https://fonts.googleapis.com/css2?family=Press+Start+2P&display=swap');`}</style>
        <div style={{ color: `#d0bcff`, fontSize: 8 }}>CONNECTING...</div>
      </div>
    )
  }

  return (
    <GameRoomContext.Provider value={value}>
      <ScoresProvider roomId={roomId}>
        <TerritoryGame onLeave={onLeave} />
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
    fontFamily: `'Press Start 2P', monospace`,
    background: `#1b1b1f`,
  },
  btn: {
    fontFamily: `inherit`,
    fontSize: 8,
    padding: `8px 24px`,
    background: `#d0bcff`,
    color: `#000`,
    border: `none`,
    cursor: `pointer`,
  },
}
