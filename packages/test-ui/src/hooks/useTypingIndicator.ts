import { useCallback, useRef, useState } from "react"
import { useLocation } from "@tanstack/react-router"
import { useStreamDB } from "../lib/stream-db-context"

export function useTypingIndicator(streamPath: string | undefined) {
  const { presenceDB, userId, sessionId, userColor } = useStreamDB()
  const location = useLocation()
  const [isTyping, setIsTyping] = useState(false)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  )

  const startTyping = useCallback(() => {
    if (!streamPath) return

    setIsTyping(true)

    // Send typing event
    presenceDB.actions.updatePresence({
      userId,
      route: location.pathname,
      streamPath,
      isTyping: true,
      lastSeen: Date.now(),
      color: userColor,
      sessionId,
    })

    // Clear previous timeout
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
    }

    // Stop typing after 3 seconds of inactivity
    timeoutRef.current = setTimeout(() => {
      setIsTyping(false)
      presenceDB.actions.updatePresence({
        userId,
        route: location.pathname,
        streamPath,
        isTyping: false,
        lastSeen: Date.now(),
        color: userColor,
        sessionId,
      })
    }, 3000)
  }, [streamPath, userId, sessionId, userColor, location.pathname, presenceDB])

  return { startTyping, isTyping }
}
