import { createFileRoute, redirect } from "@tanstack/react-router"
import { useEffect, useRef, useState } from "react"
import { DurableStream } from "@durable-streams/writer"

const SERVER_URL = `http://${typeof window !== `undefined` ? window.location.hostname : `localhost`}:8787`

export const Route = createFileRoute(`/stream/$streamPath`)({
  loader: async ({ params }) => {
    try {
      const streamMetadata = new DurableStream({
        url: `${SERVER_URL}/v1/stream/${params.streamPath}`,
      })
      const metadata = await streamMetadata.head()
      const stream = new DurableStream({
        url: `${SERVER_URL}/v1/stream/${params.streamPath}`,
        contentType: metadata.contentType || undefined,
      })
      return {
        contentType: metadata.contentType || undefined,
        stream,
      }
    } catch {
      throw redirect({ to: `/` })
    }
  },
  component: StreamViewer,
})

function StreamViewer() {
  const { streamPath } = Route.useParams()
  const { contentType, stream } = Route.useLoaderData()
  const [messages, setMessages] = useState<
    Array<{ offset: string; data: string }>
  >([])
  const [writeInput, setWriteInput] = useState(``)
  const [error, setError] = useState<string | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const abortControllerRef = useRef<AbortController | null>(null)

  const isRegistryStream = streamPath === `__registry__`
  const isJsonStream = contentType?.includes(`application/json`)

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
        const response = await stream.stream({
          offset: `-1`,
          live: `long-poll`,
          signal: controller.signal,
        })
        for await (const chunk of response.byteChunks()) {
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
        {messages.length === 0 && (
          <div
            style={{
              display: `flex`,
              alignItems: `center`,
              justifyContent: `center`,
              height: `100%`,
              color: `var(--text-dim)`,
              fontSize: `13px`,
              fontStyle: `italic`,
            }}
          >
            Listening for new messages...
          </div>
        )}
        {messages.length !== 0 ? (
          isJsonStream ? (
            messages.map((msg, i) => (
              <div key={i} className="message">
                <pre>{msg.data}</pre>
              </div>
            ))
          ) : (
            <div className="message">
              <pre>{messages.map((msg) => msg.data).join(``)}</pre>
            </div>
          )
        ) : null}
        <div ref={messagesEndRef} />
      </div>
      {!isRegistryStream && (
        <div className="write-section">
          <textarea
            placeholder="Type your message (Shift+Enter for new line)..."
            value={writeInput}
            onChange={(e) => setWriteInput(e.target.value)}
            onKeyPress={(e) => {
              if (e.key === `Enter` && !e.shiftKey) {
                e.preventDefault()
                void writeToStream()
              }
            }}
          />
          <button onClick={writeToStream}>▸ Send</button>
        </div>
      )}
    </div>
  )
}
