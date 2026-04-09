import { createContext, useContext } from "react"
import type { Transaction } from "@tanstack/react-db"
import type {
  CreateSessionPayload,
  SessionControlPayload,
  SessionSummary,
} from "./session-types"
import type { ReactNode } from "react"

export interface SessionsContextValue {
  sessions: Array<SessionSummary>
  refresh: () => Promise<void>
  replaceSession: (nextSession: SessionSummary) => void
  createSession: (payload: CreateSessionPayload) => {
    session: SessionSummary
    transaction: Transaction
  }
  controlSession: (
    session: SessionSummary,
    action: SessionControlPayload[`action`]
  ) => Transaction
}

const SessionsContext = createContext<SessionsContextValue | null>(null)

export function SessionsProvider({
  value,
  children,
}: {
  value: SessionsContextValue
  children: ReactNode
}) {
  return (
    <SessionsContext.Provider value={value}>
      {children}
    </SessionsContext.Provider>
  )
}

export function useSessions() {
  const value = useContext(SessionsContext)
  if (!value) {
    throw new Error(`useSessions must be used inside SessionsProvider`)
  }

  return value
}
