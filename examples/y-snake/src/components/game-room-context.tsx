import { createContext, useContext } from "react"
import type * as Y from "yjs"
import type { Awareness } from "y-protocols/awareness"

export interface GameRoomContextValue {
  doc: Y.Doc
  awareness: Awareness
  roomId: string
  playerId: string
  playerName: string
  playerColor: string
  isSynced: boolean
  isLoading: boolean
}

export const GameRoomContext = createContext<GameRoomContextValue | null>(null)

export function useGameRoom(): GameRoomContextValue {
  const ctx = useContext(GameRoomContext)
  if (!ctx) throw new Error(`useGameRoom must be used within GameRoom`)
  return ctx
}
