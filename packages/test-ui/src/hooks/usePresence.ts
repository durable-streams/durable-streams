import { useEffect } from "react"
import { useLocation, useParams } from "@tanstack/react-router"
import { useStreamDB } from "../lib/stream-db-context"

export function usePresence() {
  const { presenceDB, userId, sessionId, userColor } = useStreamDB()
  const location = useLocation()
  const params = useParams({ strict: false })

  // Update presence on route change
  useEffect(() => {
    presenceDB.actions.updatePresence({
      userId,
      route: location.pathname,
      streamPath: (params as any).streamPath,
      isTyping: false,
      lastSeen: Date.now(),
      color: userColor,
      sessionId,
    })
  }, [
    location.pathname,
    (params as any).streamPath,
    userId,
    sessionId,
    userColor,
    presenceDB,
  ])

  // Heartbeat every 50 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      presenceDB.actions.updatePresence({
        userId,
        route: location.pathname,
        streamPath: (params as any).streamPath,
        isTyping: false,
        lastSeen: Date.now(),
        color: userColor,
        sessionId,
      })
    }, 50000)

    return () => clearInterval(interval)
  }, [
    location.pathname,
    (params as any).streamPath,
    userId,
    sessionId,
    userColor,
    presenceDB,
  ])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      presenceDB.actions.deletePresence(sessionId)
    }
  }, [sessionId, presenceDB])
}
