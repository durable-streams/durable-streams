import { createFileRoute, redirect } from "@tanstack/react-router"
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"
import { DurableStream } from "@durable-streams/client"
import { and, eq, gt, useLiveQuery } from "@tanstack/react-db"
import ReactJson from "react-json-view"
import { useStreamDB } from "../lib/stream-db-context"
import { useTypingIndicator } from "../hooks/useTypingIndicator"
import { streamStore } from "../lib/stream-store"

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
  const { presenceDB } = useStreamDB()
  const { startTyping } = useTypingIndicator(streamPath)
  const [writeInput, setWriteInput] = useState(``)
  const [error, setError] = useState<string | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const [now, setNow] = useState(Date.now())

  // Subscribe to stream messages via external store
  const subscribe = useCallback(
    (callback: () => void) =>
      streamStore.subscribe(streamPath, stream, callback),
    [streamPath, stream]
  )

  const getSnapshot = useCallback(
    () => streamStore.getMessages(streamPath),
    [streamPath]
  )

  const messages = useSyncExternalStore(subscribe, getSnapshot)

  const isRegistryStream =
    streamPath === `__registry__` || streamPath === `__presence__`
  const isJsonStream = contentType?.includes(`application/json`)

  // Custom theme matching app colors
  const jsonTheme = {
    base00: `#ffffff`, // bg-card
    base01: `#f5f1e8`, // bg-main
    base02: `#e5dfd5`, // border-subtle
    base03: `#6b5d54`, // text-dim (comments)
    base04: `#4a4543`, // text-secondary
    base05: `#2d2a28`, // text-primary (default text)
    base06: `#2d2a28`, // text-primary
    base07: `#2d2a28`, // text-primary
    base08: `#d4704b`, // accent-primary (null, undefined, regex)
    base09: `#c8886d`, // accent-warm (numbers, booleans)
    base0A: `#7a9a7e`, // accent-secondary (functions)
    base0B: `#d4704b`, // accent-primary (strings)
    base0C: `#7a9a7e`, // accent-secondary (dates)
    base0D: `#4a4543`, // text-secondary (keys)
    base0E: `#c8886d`, // accent-warm (keywords)
    base0F: `#d4704b`, // accent-primary (deprecation)
  }

  // Update "now" every 5 seconds to re-evaluate stale typing indicators
  useEffect(() => {
    const interval = setInterval(() => {
      setNow(Date.now())
    }, 5000)
    return () => clearInterval(interval)
  }, [])

  // Query typing users for this stream
  const { data: typers = [] } = useLiveQuery(
    (q) =>
      q
        .from({ presence: presenceDB.presence })
        .where(({ presence }) =>
          and(
            eq(presence.streamPath, streamPath),
            eq(presence.isTyping, true),
            gt(presence.lastSeen, now - 60000)
          )
        ),
    [streamPath, now]
  )

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: `smooth` })
  }, [messages])

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
        <h2>{decodeURIComponent(streamPath)}</h2>
        {typers.length > 0 && (
          <span className="typing-indicator">
            {typers.map((t) => t.userId.slice(0, 8)).join(`, `)} typing...
          </span>
        )}
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
            messages.flatMap((msg, i) => {
              const parsedMessages = JSON.parse(msg.data)
              return parsedMessages.map((item, j) => (
                <div key={`${i}-${j}`} className="message json-message">
                  <ReactJson
                    src={item}
                    collapsed={1}
                    name={false}
                    displayDataTypes={false}
                    enableClipboard={false}
                    theme={jsonTheme}
                  />
                </div>
              ))
            })
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
            onChange={(e) => {
              setWriteInput(e.target.value)
              startTyping()
            }}
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
