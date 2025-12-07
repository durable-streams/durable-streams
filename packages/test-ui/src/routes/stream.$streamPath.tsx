import { createFileRoute } from "@tanstack/react-router"
import { useEffect, useRef, useState } from "react"
import { DurableStream } from "@durable-streams/writer"

export const Route = createFileRoute(`/stream/$streamPath`)({
  component: StreamViewer,
})

function StreamViewer() {
  const { streamPath } = Route.useParams()
  const [messages, setMessages] = useState<
    Array<{ offset: string; data: string }>
  >([])
  const [writeInput, setWriteInput] = useState(``)
  const [error, setError] = useState<string | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const abortControllerRef = useRef<AbortController | null>(null)

  const SERVER_URL = `http://${window.location.hostname}:8787`

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: `smooth` })
  }, [messages])

  useEffect(() => {
    const controller = new AbortController()
    abortControllerRef.current = controller
    setMessages([])
    setError(null)

    const followStream = async () => {
      try {
        const stream = new DurableStream({
          url: `${SERVER_URL}/v1/stream/${streamPath}`,
        })

        for await (const chunk of stream.read({
          offset: `-1`,
          live: `long-poll`,
          signal: controller.signal,
        })) {
          const text = new TextDecoder().decode(chunk.data)
          if (text !== ``) {
            setMessages((prev) => [
              ...prev,
              { offset: chunk.offset, data: text },
            ])
          }
        }
      } catch (err: any) {
        if (err.name !== `AbortError`) {
          setError(`Failed to follow stream: ${err.message}`)
        }
      }
    }

    void followStream()

    return () => {
      controller.abort()
      abortControllerRef.current = null
    }
  }, [streamPath])

  const writeToStream = async () => {
    if (!writeInput.trim()) return

    try {
      setError(null)
      const stream = new DurableStream({
        url: `${SERVER_URL}/v1/stream/${streamPath}`,
      })
      await stream.append(writeInput + `\n`)
      setWriteInput(``)
    } catch (err: any) {
      setError(`Failed to write to stream: ${err.message}`)
    }
  }

  return (
    <div className="stream-view">
      {error && <div className="error">{error}</div>}
      <div className="header">
        <h2>{streamPath}</h2>
      </div>
      <div className="messages">
        {messages.map((msg, i) => (
          <div key={i} className="message">
            <pre>{msg.data}</pre>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>
      <div className="write-section">
        <textarea
          placeholder="Write message..."
          value={writeInput}
          onChange={(e) => setWriteInput(e.target.value)}
          onKeyPress={(e) => {
            if (e.key === `Enter` && !e.shiftKey) {
              e.preventDefault()
              void writeToStream()
            }
          }}
        />
        <button onClick={writeToStream}>Send</button>
      </div>
    </div>
  )
}
