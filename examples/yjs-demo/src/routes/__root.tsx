import {
  Link,
  Outlet,
  createRootRoute,
  useNavigate,
} from "@tanstack/react-router"
import { useState } from "react"
import { useLiveQuery } from "@tanstack/react-db"
import { DurableStream } from "@durable-streams/client"
import {
  RegistryProvider,
  useRegistryContext,
} from "../components/registry-context"
import { ServerEndpointProvider } from "../components/server-endpoint-context"
import type { RoomMetadata } from "../utils/schemas"
import "../styles.css"

function RoomItem({ room }: { room: RoomMetadata }) {
  const { registryDB, serverEndpoint } = useRegistryContext()
  const navigate = useNavigate()
  const [isDeleting, setIsDeleting] = useState(false)

  const handleDelete = async (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()

    if (isDeleting) return

    setIsDeleting(true)
    try {
      // Delete the room stream
      const stream = new DurableStream({
        url: `${serverEndpoint}/v1/stream/rooms/${room.roomId}`,
        contentType: `application/octet-stream`,
      })
      await stream.delete()

      // Remove from registry
      await registryDB.actions.deleteRoom(room.roomId)

      // Navigate to index
      navigate({ to: `/` })
    } catch (err) {
      console.error(`Failed to delete room:`, err)
    } finally {
      setIsDeleting(false)
    }
  }

  return (
    <Link
      to="/room/$roomId"
      params={{ roomId: room.roomId }}
      className="room-item"
      activeProps={{ className: `room-item active` }}
    >
      <span className="room-name">{room.name}</span>
      <button
        className="room-delete"
        onClick={handleDelete}
        disabled={isDeleting}
        title="Delete room"
      >
        {isDeleting ? `...` : `×`}
      </button>
    </Link>
  )
}

function RoomList() {
  const { registryDB } = useRegistryContext()

  // Query all rooms from registry
  const { data: rooms = [] } = useLiveQuery((q) =>
    q.from({ rooms: registryDB.collections.rooms })
  )

  // Sort by createdAt descending
  const sortedRooms = [...rooms].sort((a, b) => b.createdAt - a.createdAt)

  return (
    <div className="room-list">
      {sortedRooms.length === 0 ? (
        <div className="empty-state">
          No rooms yet. Create one to get started.
        </div>
      ) : (
        sortedRooms.map((room) => <RoomItem key={room.roomId} room={room} />)
      )}
    </div>
  )
}

function CreateRoomForm() {
  const { registryDB, serverEndpoint } = useRegistryContext()
  const navigate = useNavigate()
  const [name, setName] = useState(``)
  const [isCreating, setIsCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim() || isCreating) return

    setIsCreating(true)
    setError(null)

    try {
      const roomId = crypto.randomUUID()

      // Create the Yjs document stream via PUT to the Yjs API
      const createResponse = await fetch(
        `${serverEndpoint}/v1/yjs/rooms/docs/${roomId}`,
        { method: `PUT` }
      )
      if (!createResponse.ok && createResponse.status !== 409) {
        throw new Error(`Failed to create document: ${createResponse.status}`)
      }

      // Add to registry
      const metadata: RoomMetadata = {
        roomId,
        name: name.trim(),
        createdAt: Date.now(),
      }

      await registryDB.actions.addRoom(metadata)
      setName(``)

      // Navigate to the new room
      navigate({ to: `/room/$roomId`, params: { roomId } })
    } catch (err) {
      console.error(`Failed to create room:`, err)
      setError(err instanceof Error ? err.message : `Failed to create room`)
    } finally {
      setIsCreating(false)
    }
  }

  return (
    <div>
      <form className="create-room-form" onSubmit={handleSubmit}>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Room name..."
          disabled={isCreating}
        />
        <button type="submit" disabled={!name.trim() || isCreating}>
          {isCreating ? `Creating...` : `Create`}
        </button>
      </form>
      {error && (
        <div
          style={{ padding: `8px 12px`, color: `#f48771`, fontSize: `12px` }}
        >
          {error}
        </div>
      )}
    </div>
  )
}

function Sidebar() {
  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <h1>Yjs - Durable Streams</h1>
      </div>
      <CreateRoomForm />
      <RoomList />
    </aside>
  )
}

function RootLayout() {
  return (
    <ServerEndpointProvider>
      <RegistryProvider>
        <div className="app-layout">
          <Sidebar />
          <main className="main-content">
            <Outlet />
          </main>
        </div>
      </RegistryProvider>
    </ServerEndpointProvider>
  )
}

export const Route = createRootRoute({
  component: RootLayout,
})
