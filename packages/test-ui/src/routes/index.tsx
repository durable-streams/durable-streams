import { createFileRoute } from '@tanstack/react-router'
import { useState, useEffect, useRef } from 'react'
import { DurableStream } from '@durable-streams/writer'
import '../styles.css'

export const Route = createFileRoute('/')({
  component: Index,
})

interface Stream {
  path: string
  contentType?: string
}

function Index() {
  const [streams, setStreams] = useState<Stream[]>([])
  const [selectedStream, setSelectedStream] = useState<string | null>(null)
  const [newStreamPath, setNewStreamPath] = useState('')
  const [newStreamContentType, setNewStreamContentType] = useState('text/plain')
  const [messages, setMessages] = useState<{ offset: string; data: string }[]>([])
  const [writeInput, setWriteInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isFollowing, setIsFollowing] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const abortControllerRef = useRef<AbortController | null>(null)

  const SERVER_URL = 'http://localhost:8787'

  useEffect(() => {
    void loadStreamsFromRegistry()
  }, [])

  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages])

  useEffect(() => {
    if (selectedStream && !isFollowing) {
      void startFollowing(selectedStream)
    }
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort()
        abortControllerRef.current = null
      }
    }
  }, [selectedStream, isFollowing])

  const loadStreamsFromRegistry = async () => {
    try {
      const registryStream = new DurableStream({
        url: `${SERVER_URL}/v1/stream/__registry__`,
      })

      // Check if registry exists first
      const exists = await registryStream.head().catch(() => null)
      if (!exists) {
        return
      }

      const result = await registryStream.read({ offset: '-1' }).catch(() => null)
      if (result && result.data.length > 0) {
        const text = new TextDecoder().decode(result.data)
        const lines = text.trim().split('\n').filter(Boolean)
        const loadedStreams: Stream[] = []

        for (const line of lines) {
          try {
            const event = JSON.parse(line)
            if (event.type === 'created') {
              loadedStreams.push({ path: event.path, contentType: event.contentType })
            } else if (event.type === 'deleted') {
              const index = loadedStreams.findIndex((s) => s.path === event.path)
              if (index !== -1) {
                loadedStreams.splice(index, 1)
              }
            }
          } catch {
            // Ignore malformed JSON lines
          }
        }

        setStreams(loadedStreams)
      }
    } catch (err) {
      console.error('Failed to load streams from registry:', err)
    }
  }

  const createStream = async () => {
    if (!newStreamPath.trim()) {
      setError('Stream path cannot be empty')
      return
    }

    try {
      setError(null)
      await DurableStream.create({
        url: `${SERVER_URL}/v1/stream/${newStreamPath}`,
        contentType: newStreamContentType,
      })

      setStreams([...streams, { path: newStreamPath, contentType: newStreamContentType }])
      setNewStreamPath('')
      setSelectedStream(newStreamPath)
    } catch (err: any) {
      setError(`Failed to create stream: ${err.message}`)
    }
  }

  const deleteStream = async (path: string) => {
    try {
      setError(null)
      const stream = new DurableStream({
        url: `${SERVER_URL}/v1/stream/${path}`,
      })
      await stream.delete()

      setStreams(streams.filter((s) => s.path !== path))
      if (selectedStream === path) {
        setSelectedStream(null)
        setMessages([])
      }
    } catch (err: any) {
      setError(`Failed to delete stream: ${err.message}`)
    }
  }

  const startFollowing = async (path: string) => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
    }

    const controller = new AbortController()
    abortControllerRef.current = controller

    setIsFollowing(true)
    setMessages([])
    setError(null)

    try {
      const stream = new DurableStream({
        url: `${SERVER_URL}/v1/stream/${path}`,
      })

      for await (const chunk of stream.follow({ offset: '-1', signal: controller.signal })) {
        const text = new TextDecoder().decode(chunk.data)
        setMessages((prev) => [...prev, { offset: chunk.offset, data: text }])
      }
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        setError(`Failed to follow stream: ${err.message}`)
      }
    } finally {
      setIsFollowing(false)
    }
  }

  const writeToStream = async () => {
    if (!selectedStream || !writeInput.trim()) return

    try {
      setError(null)
      const stream = new DurableStream({
        url: `${SERVER_URL}/v1/stream/${selectedStream}`,
      })
      await stream.append(writeInput + '\n')
      setWriteInput('')
    } catch (err: any) {
      setError(`Failed to write to stream: ${err.message}`)
    }
  }

  return (
    <div className="container">
      <div className="sidebar">
        <h2>Streams</h2>
        <div className="create-stream">
          <input
            type="text"
            placeholder="Stream path"
            value={newStreamPath}
            onChange={(e) => setNewStreamPath(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && createStream()}
          />
          <select
            value={newStreamContentType}
            onChange={(e) => setNewStreamContentType(e.target.value)}
          >
            <option value="text/plain">text/plain</option>
            <option value="application/json">application/json</option>
            <option value="application/octet-stream">binary</option>
          </select>
          <button onClick={createStream}>Create</button>
        </div>
        <div className="stream-list">
          {streams.map((stream) => (
            <div
              key={stream.path}
              className={`stream-item ${selectedStream === stream.path ? 'active' : ''}`}
            >
              <div onClick={() => setSelectedStream(stream.path)}>
                <div className="stream-path">{stream.path}</div>
                <div className="stream-type">{stream.contentType || 'unknown'}</div>
              </div>
              <button
                className="delete-btn"
                onClick={(e) => {
                  e.stopPropagation()
                  deleteStream(stream.path)
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      </div>
      <div className="main">
        {error && <div className="error">{error}</div>}
        {selectedStream ? (
          <>
            <div className="header">
              <h2>{selectedStream}</h2>
              <span className="status">{isFollowing ? 'Following' : 'Disconnected'}</span>
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
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    writeToStream()
                  }
                }}
              />
              <button onClick={writeToStream}>Send</button>
            </div>
          </>
        ) : (
          <div className="placeholder">Select a stream to start</div>
        )}
      </div>
    </div>
  )
}
