import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useEffect, useRef, useState } from "react"
import { EditorState } from "@codemirror/state"
import { EditorView, basicSetup } from "codemirror"
import { keymap } from "@codemirror/view"
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next"
import { useLiveQuery } from "@tanstack/react-db"
import { YjsRoomProvider, useYjsRoom } from "../lib/yjs-provider"
import { useRegistryContext } from "../lib/registry-context"

// ============================================================================
// Presence Display
// ============================================================================

interface UserState {
  name: string
  color: string
  colorLight: string
}

interface TrackedUser {
  user: UserState
  lastActive: number
}

const INACTIVE_TIMEOUT = 35000 // 35 seconds

function PresenceList() {
  const { awareness } = useYjsRoom()
  const [users, setUsers] = useState<Map<number, TrackedUser>>(new Map())

  useEffect(() => {
    const updateUsers = () => {
      const states = awareness.getStates()
      const now = Date.now()

      setUsers(() => {
        const newUsers = new Map<number, TrackedUser>()

        states.forEach((state, clientId) => {
          if (state.user) {
            newUsers.set(clientId, {
              user: state.user as UserState,
              lastActive: now,
            })
          }
        })

        return newUsers
      })
    }

    // Initial update
    updateUsers()

    // Listen for changes
    awareness.on(`change`, updateUsers)

    // Periodically clean up inactive users
    const cleanupInterval = setInterval(() => {
      const now = Date.now()
      setUsers((prev) => {
        const filtered = new Map<number, TrackedUser>()
        prev.forEach((tracked, clientId) => {
          if (
            clientId === awareness.clientID ||
            now - tracked.lastActive < INACTIVE_TIMEOUT
          ) {
            filtered.set(clientId, tracked)
          }
        })
        return filtered
      })
    }, 1000)

    return () => {
      awareness.off(`change`, updateUsers)
      clearInterval(cleanupInterval)
    }
  }, [awareness])

  // Filter out current user - they have the editable UsernameEditor on the right
  const otherUsers = [...users.entries()].filter(
    ([clientId]) => clientId !== awareness.clientID
  )

  if (otherUsers.length === 0) {
    return null
  }

  return (
    <div className="presence-list">
      {otherUsers.map(([clientId, { user }]) => (
        <div
          key={clientId}
          className="presence-user"
          style={{ borderColor: user.color }}
          title={user.name}
        >
          <span
            className="presence-dot"
            style={{ backgroundColor: user.color }}
          />
          <span className="presence-name">{user.name}</span>
        </div>
      ))}
    </div>
  )
}

// ============================================================================
// Username Editor
// ============================================================================

function UsernameEditor() {
  const { username, setUsername } = useYjsRoom()
  const [isEditing, setIsEditing] = useState(false)
  const [editValue, setEditValue] = useState(username)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [isEditing])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (editValue.trim()) {
      setUsername(editValue.trim())
    }
    setIsEditing(false)
  }

  const handleBlur = () => {
    if (editValue.trim()) {
      setUsername(editValue.trim())
    } else {
      setEditValue(username)
    }
    setIsEditing(false)
  }

  if (isEditing) {
    return (
      <form onSubmit={handleSubmit} className="username-form">
        <input
          ref={inputRef}
          type="text"
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={handleBlur}
          className="username-input"
          placeholder="Enter name..."
        />
      </form>
    )
  }

  return (
    <button
      className="username-display"
      onClick={() => {
        setEditValue(username)
        setIsEditing(true)
      }}
      title="Click to edit username"
    >
      {username}
    </button>
  )
}

// ============================================================================
// CodeMirror Editor with Yjs binding
// ============================================================================

function CollaborativeEditor() {
  const { doc, awareness, isLoading, isSynced, error } = useYjsRoom()
  const editorContainerRef = useRef<HTMLDivElement>(null)
  const editorViewRef = useRef<EditorView | null>(null)
  const [_editorReady, setEditorReady] = useState(false)

  // Only create editor after synced (not just connected)
  useEffect(() => {
    if (!editorContainerRef.current) return
    if (!isSynced) return // Wait until synced with server
    if (editorViewRef.current) return // Already created

    // Get Y.Text for document content
    const ytext = doc.getText(`content`)

    // Create CodeMirror state with Yjs collaboration (plain text, no syntax highlighting)
    const state = EditorState.create({
      doc: ytext.toString(),
      extensions: [
        keymap.of([...yUndoManagerKeymap]),
        basicSetup,
        EditorView.lineWrapping,
        yCollab(ytext, awareness),
        EditorView.theme({
          "&": {
            height: `100%`,
            backgroundColor: `var(--bg-main)`,
          },
          ".cm-content": {
            fontFamily: `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, sans-serif`,
            fontSize: `15px`,
            lineHeight: `1.6`,
            color: `var(--text-primary)`,
          },
          ".cm-gutters": {
            backgroundColor: `var(--bg-secondary)`,
            color: `var(--text-dim)`,
            border: `none`,
          },
          ".cm-cursor": {
            borderLeftColor: `var(--accent)`,
          },
          ".cm-activeLine": {
            backgroundColor: `var(--active-line-bg)`,
          },
          ".cm-activeLineGutter": {
            backgroundColor: `var(--active-line-bg)`,
          },
          ".cm-selectionBackground": {
            backgroundColor: `var(--selection-bg) !important`,
          },
          "&.cm-focused .cm-selectionBackground": {
            backgroundColor: `var(--selection-bg) !important`,
          },
          ".cm-scroller": {
            overflow: `auto`,
          },
        }),
      ],
    })

    const view = new EditorView({
      state,
      parent: editorContainerRef.current,
    })

    editorViewRef.current = view
    setEditorReady(true)

    return () => {
      if (editorViewRef.current) {
        editorViewRef.current.destroy()
        editorViewRef.current = null
        setEditorReady(false)
      }
    }
  }, [doc, awareness, isSynced])

  if (error) {
    return (
      <div className="error-state">
        <h3>Error connecting to room</h3>
        <p>{error.message}</p>
        <p
          style={{
            marginTop: `12px`,
            fontSize: `12px`,
            color: `var(--text-dim)`,
          }}
        >
          Please check your server endpoint configuration and ensure the server
          is accessible.
        </p>
      </div>
    )
  }

  const showLoading = isLoading || !isSynced

  return (
    <div className="editor-container">
      <div className="editor-header">
        <div className="editor-status">
          {isLoading ? (
            <span className="status loading">Loading...</span>
          ) : isSynced ? (
            <span className="status synced">Synced</span>
          ) : (
            <span className="status connecting">Connecting...</span>
          )}
        </div>
        <div className="editor-toolbar">
          <PresenceList />
          <UsernameEditor />
        </div>
      </div>
      <div className="editor-wrapper">
        {showLoading && (
          <div className="loading-placeholder">Connecting to room...</div>
        )}
        <div
          ref={editorContainerRef}
          className="codemirror-editor"
          style={{ display: showLoading ? `none` : `flex` }}
        />
      </div>
    </div>
  )
}

// ============================================================================
// Room View
// ============================================================================

function RoomView() {
  const { roomId } = Route.useParams()
  const navigate = useNavigate()
  const { registryDB } = useRegistryContext()

  // Check if room exists in registry
  const { data: rooms = [] } = useLiveQuery((q) =>
    q.from({ rooms: registryDB.collections.rooms })
  )

  const roomExists = rooms.some((room) => room.roomId === roomId)

  // Redirect to index if room doesn't exist
  useEffect(() => {
    if (rooms.length >= 0 && !roomExists) {
      // Only redirect after we've loaded rooms (not during initial load)
      // We check rooms.length >= 0 to ensure the query has resolved
      const timer = setTimeout(() => {
        navigate({ to: `/` })
      }, 100)
      return () => clearTimeout(timer)
    }
  }, [roomExists, rooms.length, navigate])

  if (!roomExists) {
    return (
      <div className="loading-placeholder">Room not found. Redirecting...</div>
    )
  }

  return (
    <YjsRoomProvider key={roomId} roomId={roomId}>
      <CollaborativeEditor />
    </YjsRoomProvider>
  )
}

export const Route = createFileRoute(`/room/$roomId`)({
  component: RoomView,
})
