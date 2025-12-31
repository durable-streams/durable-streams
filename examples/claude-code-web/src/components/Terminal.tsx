import { useCallback, useEffect, useRef, useState } from "react"
import { DurableStream } from "@durable-streams/client"
import { createTerminal, type TerminalInstance } from "~/lib/terminal"

// Maximum bytes to catch up on reconnect (32KB)
const MAX_CATCHUP_BYTES = 32 * 1024

interface TerminalProps {
  sessionId: string
  inputStreamUrl: string
  outputStreamUrl: string
  onResize?: (cols: number, rows: number) => void
  onDisconnect?: () => void
}

export function Terminal({
  sessionId,
  inputStreamUrl,
  outputStreamUrl,
  onResize,
}: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<TerminalInstance | null>(null)
  const inputStreamRef = useRef<DurableStream | null>(null)
  const outputAbortRef = useRef<AbortController | null>(null)
  const [isConnected, setIsConnected] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const connect = useCallback(async () => {
    if (!containerRef.current) return

    // Cleanup any existing connections
    if (outputAbortRef.current) {
      outputAbortRef.current.abort()
    }
    if (terminalRef.current) {
      terminalRef.current.dispose()
      terminalRef.current = null
    }

    setError(null)

    try {
      // Create terminal instance
      const terminal = createTerminal(containerRef.current)
      terminalRef.current = terminal

      // Set up output stream subscription with abort controller
      const outputAbort = new AbortController()
      outputAbortRef.current = outputAbort

      const outputStream = new DurableStream({ url: outputStreamUrl })

      // First, catch up on existing output (limited for performance)
      const catchUpRes = await outputStream.stream({
        live: false,
        signal: outputAbort.signal,
      })

      let totalBytes = 0
      const catchUpChunks: Uint8Array[] = []

      catchUpRes.subscribeBytes((chunk) => {
        catchUpChunks.push(chunk.data)
        totalBytes += chunk.data.length
      })

      // Wait for catchup to complete
      await new Promise((resolve) => setTimeout(resolve, 200))

      // Only render the last MAX_CATCHUP_BYTES of history
      if (totalBytes > 0) {
        let bytesToSkip = Math.max(0, totalBytes - MAX_CATCHUP_BYTES)
        for (const chunk of catchUpChunks) {
          if (bytesToSkip >= chunk.length) {
            bytesToSkip -= chunk.length
            continue
          }
          const data = bytesToSkip > 0 ? chunk.slice(bytesToSkip) : chunk
          bytesToSkip = 0
          terminal.write(data)
        }
      }

      // Now subscribe to live updates
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

      // Wire up paste events
      terminal.onPaste(async (text: string) => {
        try {
          const encoder = new TextEncoder()
          await inputStreamRef.current?.append(encoder.encode(text))
        } catch (err) {
          console.error("Failed to send paste:", err)
        }
      })

      // Wire up resize events
      terminal.onResize(async (cols: number, rows: number) => {
        onResize?.(cols, rows)
      })

      // Fit terminal and send initial size
      terminal.fit()
      await new Promise((resolve) => setTimeout(resolve, 50))
      const { cols, rows } = terminal.getDimensions()
      onResize?.(cols, rows)

      terminal.focus()
      setIsConnected(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Connection failed")
      setIsConnected(false)
    }
  }, [sessionId, inputStreamUrl, outputStreamUrl, onResize])

  // Connect on mount and when session changes
  useEffect(() => {
    connect()

    return () => {
      if (outputAbortRef.current) {
        outputAbortRef.current.abort()
      }
      if (terminalRef.current) {
        terminalRef.current.dispose()
      }
    }
  }, [connect])

  return (
    <div className="terminal-wrapper">
      {error && <div className="terminal-error">{error}</div>}
      {!isConnected && !error && (
        <div className="terminal-connecting">Connecting...</div>
      )}
      <div
        ref={containerRef}
        className={`terminal-container ${isConnected ? "connected" : ""}`}
        tabIndex={0}
      />
    </div>
  )
}
