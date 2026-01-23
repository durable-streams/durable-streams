import { useState, useEffect, useRef, useMemo } from "react"
import {
  createAISession,
  type AISession,
  type Message,
  type Delta,
  type Agent,
} from "@durable-streams/ai-session"
import { useLiveQuery } from "@tanstack/react-db"
import { Streamdown } from "streamdown"

// Styles
const styles = {
  container: {
    maxWidth: "900px",
    margin: "0 auto",
    padding: "20px",
    display: "flex",
    flexDirection: "column" as const,
    height: "100vh",
  },
  header: {
    borderBottom: "1px solid #333",
    paddingBottom: "16px",
    marginBottom: "20px",
  },
  title: {
    fontSize: "24px",
    fontWeight: "bold",
    marginBottom: "8px",
  },
  subtitle: {
    color: "#888",
    fontSize: "14px",
  },
  stats: {
    display: "flex",
    gap: "20px",
    marginTop: "12px",
  },
  stat: {
    background: "#1a1a1a",
    padding: "8px 16px",
    borderRadius: "8px",
    fontSize: "14px",
  },
  messagesContainer: {
    flex: 1,
    overflowY: "auto" as const,
    paddingRight: "10px",
  },
  message: {
    marginBottom: "16px",
    padding: "16px",
    borderRadius: "12px",
    background: "#1a1a1a",
  },
  messageUser: {
    background: "#1e3a5f",
    marginLeft: "40px",
  },
  messageAgent: {
    marginRight: "40px",
  },
  messageHeader: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    marginBottom: "8px",
  },
  avatar: {
    width: "32px",
    height: "32px",
    borderRadius: "50%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "14px",
    fontWeight: "bold",
  },
  sender: {
    fontWeight: "600",
    fontSize: "14px",
  },
  timestamp: {
    color: "#666",
    fontSize: "12px",
    marginLeft: "auto",
  },
  content: {
    lineHeight: "1.6",
    whiteSpace: "pre-wrap" as const,
  },
  inputContainer: {
    borderTop: "1px solid #333",
    paddingTop: "16px",
    display: "flex",
    gap: "12px",
  },
  input: {
    flex: 1,
    padding: "12px 16px",
    borderRadius: "8px",
    border: "1px solid #333",
    background: "#1a1a1a",
    color: "#e5e5e5",
    fontSize: "14px",
    outline: "none",
  },
  button: {
    padding: "12px 24px",
    borderRadius: "8px",
    border: "none",
    background: "#3b82f6",
    color: "white",
    fontWeight: "600",
    cursor: "pointer",
  },
  buttonSecondary: {
    background: "#333",
  },
  agentButtons: {
    display: "flex",
    gap: "8px",
    marginTop: "12px",
  },
  presence: {
    display: "flex",
    gap: "8px",
    marginTop: "8px",
  },
  presenceDot: {
    width: "8px",
    height: "8px",
    borderRadius: "50%",
    background: "#22c55e",
  },
}

// Agent colors
const agentColors: Record<string, string> = {
  filesystem: "#f97316",
  api: "#22c55e",
  user: "#3b82f6",
}

function getAgentColor(id: string): string {
  return agentColors[id] || "#888"
}


// Inner component that uses useLiveQuery hooks
function SessionView({ session }: { session: AISession }) {
  const [input, setInput] = useState("")
  const messagesEndRef = useRef<HTMLDivElement>(null)

  // Use TanStack DB live queries for reactive data
  // Pass collections directly to useLiveQuery (works because they're TanStack DB Collections)
  const messagesQuery = useLiveQuery(session.db.collections.messages as any)
  const deltasQuery = useLiveQuery(session.db.collections.deltas as any)
  const agentsQuery = useLiveQuery(session.db.collections.agents as any)

  const messages = (messagesQuery.data || []) as Message[]
  const deltas = (deltasQuery.data || []) as Delta[]
  const agents = (agentsQuery.data || []) as Agent[]

  // Sort messages by time
  const sortedMessages = [...messages].sort((a, b) => a.createdAt - b.createdAt)

  // Pre-compute message parts from deltas (text, tool-calls, tool-results)
  interface MessagePart {
    type: "text" | "tool-call" | "tool-result"
    content: string
    toolName?: string
    toolCallId?: string
  }

  const messageParts = useMemo(() => {
    const partsMap = new Map<string, MessagePart[]>()

    // Group deltas by messageId
    const grouped = new Map<string, Delta[]>()
    for (const delta of deltas) {
      const existing = grouped.get(delta.messageId) ?? []
      existing.push(delta)
      grouped.set(delta.messageId, existing)
    }

    // Build parts for each message
    for (const [messageId, messageDeltas] of grouped) {
      // Sort by partIndex, then seq
      const sorted = messageDeltas.sort((a, b) => {
        if (a.partIndex !== b.partIndex) return a.partIndex - b.partIndex
        return a.seq - b.seq
      })

      // Group by partIndex to combine text deltas
      const partGroups = new Map<number, Delta[]>()
      for (const d of sorted) {
        const existing = partGroups.get(d.partIndex) ?? []
        existing.push(d)
        partGroups.set(d.partIndex, existing)
      }

      const parts: MessagePart[] = []
      for (const [, partDeltas] of [...partGroups.entries()].sort((a, b) => a[0] - b[0])) {
        const first = partDeltas[0]
        if (first.partType === "text") {
          parts.push({
            type: "text",
            content: partDeltas.map(d => d.text ?? "").join(""),
          })
        } else if (first.partType === "tool-call") {
          parts.push({
            type: "tool-call",
            content: first.text ?? "",
            toolName: first.toolName,
            toolCallId: first.toolCallId,
          })
        } else if (first.partType === "tool-result") {
          parts.push({
            type: "tool-result",
            content: first.text ?? "",
            toolName: first.toolName,
            toolCallId: first.toolCallId,
          })
        }
      }
      partsMap.set(messageId, parts)
    }

    return partsMap
  }, [deltas])

  // Helper to get just text content for simple display
  const getTextContent = (messageId: string): string => {
    const parts = messageParts.get(messageId) ?? []
    return parts.filter(p => p.type === "text").map(p => p.content).join("")
  }

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages.length, deltas.length])

  // Send user message - agents listening to stream will respond automatically
  async function sendMessage() {
    if (!input.trim()) return

    const msg = await session.createMessage({
      role: "user",
      status: "done",
      userId: "demo-user",
    })

    await session.appendDelta({
      messageId: msg.id,
      partIndex: 0,
      partType: "text",
      seq: 0,
      text: input,
      done: true,
    })

    setInput("")
  }

  return (
    <div style={styles.container}>
      <header style={styles.header}>
        <h1 style={styles.title}>Durable AI Session</h1>
        <p style={styles.subtitle}>
          Multi-agent collaboration with persistent streaming
        </p>
        <div style={styles.stats}>
          <span style={styles.stat}>Connected</span>
          <span style={styles.stat}>Messages: {messages.length}</span>
          <span style={styles.stat}>Deltas: {deltas.length}</span>
          <span style={styles.stat}>
            Agents: {agents.map(a => a.name).join(", ") || "none connected"}
          </span>
        </div>
      </header>

      <div style={styles.messagesContainer}>
        {sortedMessages.map((msg) => {
          const isUser = msg.role === "user"
          const parts = messageParts.get(msg.id) ?? []
          const textContent = getTextContent(msg.id)
          const agent = agents.find((a) => a.id === msg.agentId)
          const color = getAgentColor(msg.agentId || "user")

          return (
            <div
              key={msg.id}
              style={{
                ...styles.message,
                ...(isUser ? styles.messageUser : styles.messageAgent),
              }}
            >
              <div style={styles.messageHeader}>
                <div style={{ ...styles.avatar, background: color }}>
                  {isUser ? "U" : agent?.name?.[0] || "?"}
                </div>
                <span style={styles.sender}>
                  {isUser ? "You" : agent?.name || msg.agentId}
                </span>
                <span style={styles.timestamp}>
                  {new Date(msg.createdAt).toLocaleTimeString()}
                </span>
              </div>
              <div style={styles.content}>
                {isUser ? (
                  textContent || "..."
                ) : (
                  <>
                    {parts.map((part, i) => {
                      switch (part.type) {
                        case "text":
                          return (
                            <Streamdown key={i} isAnimating={msg.status === "streaming"}>
                              {part.content}
                            </Streamdown>
                          )
                        case "tool-call":
                          return (
                            <div key={i} style={{
                              background: "#2a2a3a",
                              borderRadius: "8px",
                              padding: "12px",
                              margin: "8px 0",
                              fontSize: "13px",
                            }}>
                              <div style={{ color: "#a78bfa", fontWeight: 600, marginBottom: "4px" }}>
                                🔧 {part.toolName}
                              </div>
                              <pre style={{ margin: 0, color: "#9ca3af", overflow: "auto" }}>
                                {part.content}
                              </pre>
                            </div>
                          )
                        case "tool-result":
                          return (
                            <div key={i} style={{
                              background: "#1a2a1a",
                              borderRadius: "8px",
                              padding: "12px",
                              margin: "8px 0",
                              fontSize: "13px",
                              borderLeft: "3px solid #22c55e",
                            }}>
                              <div style={{ color: "#22c55e", fontWeight: 600, marginBottom: "4px" }}>
                                ✓ Result
                              </div>
                              <pre style={{ margin: 0, color: "#9ca3af", overflow: "auto", whiteSpace: "pre-wrap" }}>
                                {part.content.length > 500 ? part.content.slice(0, 500) + "..." : part.content}
                              </pre>
                            </div>
                          )
                        default:
                          return null
                      }
                    })}
                    {parts.length === 0 && "..."}
                  </>
                )}
              </div>
            </div>
          )
        })}
        <div ref={messagesEndRef} />
      </div>

      <div style={styles.inputContainer}>
        <input
          style={styles.input}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && sendMessage()}
          placeholder="Type a message..."
        />
        <button
          style={styles.button}
          onClick={sendMessage}
          disabled={!input.trim()}
        >
          Send
        </button>
      </div>

      <div style={styles.agentButtons}>
        <button
          style={{ ...styles.button, ...styles.buttonSecondary }}
          onClick={() => {
            localStorage.removeItem("ai-session-id")
            window.location.href = window.location.pathname
          }}
        >
          New Session
        </button>
      </div>
    </div>
  )
}

export default function App() {
  const [session, setSession] = useState<AISession | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Connect to session
  useEffect(() => {
    async function connect() {
      const serverUrl = "http://localhost:4000"

      // Use session ID from URL or localStorage for persistence
      const urlParams = new URLSearchParams(window.location.search)
      let sessionId = urlParams.get("session")

      if (!sessionId) {
        sessionId = localStorage.getItem("ai-session-id")
      }

      if (!sessionId) {
        sessionId = `demo-${Date.now()}`
        window.history.replaceState({}, "", `?session=${sessionId}`)
      }
      localStorage.setItem("ai-session-id", sessionId)

      try {
        const sess = await createAISession({
          url: `${serverUrl}/sessions/${sessionId}`,
          create: true, // Always try to create - server handles "already exists"
        })

        // Register agents
        await sess.registerAgent({ id: "filesystem", name: "File Explorer", model: "claude-sonnet-4-5-20250514" })
        await sess.registerAgent({ id: "api", name: "Web Explorer", model: "claude-sonnet-4-5-20250514" })

        // Preload data
        await sess.preload()

        setSession(sess)
      } catch (err) {
        console.error("Failed to connect:", err)
        setError(err instanceof Error ? err.message : "Failed to connect")
      }
    }

    connect()

    return () => {
      session?.close()
    }
  }, [])

  if (error) {
    return (
      <div style={styles.container}>
        <div style={{ color: "#ef4444", padding: "20px" }}>
          Error: {error}
        </div>
      </div>
    )
  }

  if (!session) {
    return (
      <div style={styles.container}>
        <div style={{ padding: "20px" }}>Connecting...</div>
      </div>
    )
  }

  return <SessionView session={session} />
}
