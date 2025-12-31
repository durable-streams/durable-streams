import { useCallback, useEffect, useRef, useState } from "react"
import { DurableStream } from "@durable-streams/client"
import { createTerminal, type TerminalInstance } from "~/lib/terminal"

interface DirectAccessProps {
  sessionId: string
  onClose: () => void
}

export function DirectAccess({ sessionId, onClose }: DirectAccessProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<TerminalInstance | null>(null)
  const inputStreamRef = useRef<DurableStream | null>(null)
  const outputAbortRef = useRef<AbortController | null>(null)
  const [isConnected, setIsConnected] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [directSession, setDirectSession] = useState<{
    directSessionId: string
    inputStream: string
    outputStream: string
  } | null>(null)

  // Request direct access session
  useEffect(() => {
    async function requestDirectAccess() {
      try {
        const response = await fetch(
          `/api/sessions/${sessionId}/direct-access`,
          { method: "POST" }
        )
        if (!response.ok) {
          throw new Error("Failed to create direct access session")
        }
        const data = await response.json()
        setDirectSession(data)
      } catch (err) {
        setError(err instanceof Error ? err.message : "Connection failed")
      }
    }
    requestDirectAccess()
  }, [sessionId])

  // Connect terminal when direct session is ready
  const connect = useCallback(async () => {
    if (!containerRef.current || !directSession) return

    // Cleanup any existing connections
    if (outputAbortRef.current) {
      outputAbortRef.current.abort()
    }
    if (terminalRef.current) {
      terminalRef.current.dispose()
      terminalRef.current = null
    }

    try {
      const terminal = createTerminal(containerRef.current)
      terminalRef.current = terminal

      const outputAbort = new AbortController()
      outputAbortRef.current = outputAbort

      const baseUrl = window.location.origin
      const outputStreamUrl = `${baseUrl}${directSession.outputStream}`
      const inputStreamUrl = `${baseUrl}${directSession.inputStream}`

      const outputStream = new DurableStream({ url: outputStreamUrl })

      // Subscribe to live output (no catchup needed for new session)
      const liveRes = await outputStream.stream({
        live: "long-poll",
        signal: outputAbort.signal,
      })

      liveRes.subscribeBytes((chunk) => {
        if (outputAbort.signal.aborted) return
        terminal.write(chunk.data)
      })

      // Set up input stream
      const inputStream = await DurableStream.create({
        url: inputStreamUrl,
        contentType: "application/octet-stream",
      })
      inputStreamRef.current = inputStream

      // Wire up keyboard input
      terminal.onData(async (data: string) => {
        try {
          const encoder = new TextEncoder()
          await inputStreamRef.current?.append(encoder.encode(data))
        } catch (err) {
          console.error("Failed to send input:", err)
        }
      })

      // Wire up paste
      terminal.onPaste(async (text: string) => {
        try {
          const encoder = new TextEncoder()
          await inputStreamRef.current?.append(encoder.encode(text))
        } catch (err) {
          console.error("Failed to send paste:", err)
        }
      })

      // Wire up resize
      terminal.onResize(async (cols: number, rows: number) => {
        try {
          await fetch(
            `/api/sessions/${sessionId}/direct-access/${directSession.directSessionId}/resize`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ cols, rows }),
            }
          )
        } catch (err) {
          console.error("Failed to send resize:", err)
        }
      })

      terminal.fit()
      await new Promise((resolve) => setTimeout(resolve, 50))
      terminal.focus()
      setIsConnected(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Connection failed")
    }
  }, [sessionId, directSession])

  useEffect(() => {
    if (directSession) {
      connect()
    }

    return () => {
      if (outputAbortRef.current) {
        outputAbortRef.current.abort()
      }
      if (terminalRef.current) {
        terminalRef.current.dispose()
      }
    }
  }, [connect, directSession])

  // Handle escape key to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose()
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [onClose])

  return (
    <div className="direct-access-modal">
      <div className="direct-access-overlay" onClick={onClose} />
      <div className="direct-access-content">
        <div className="direct-access-header">
          <h3>Direct Access - bash</h3>
          <button onClick={onClose} className="close-btn">
            &times;
          </button>
        </div>
        {error && <div className="direct-access-error">{error}</div>}
        {!isConnected && !error && (
          <div className="direct-access-connecting">Connecting...</div>
        )}
        <div
          ref={containerRef}
          className={`direct-access-terminal ${isConnected ? "connected" : ""}`}
          tabIndex={0}
        />
      </div>
    </div>
  )
}
