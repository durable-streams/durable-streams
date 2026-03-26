import { useEffect, useState } from "react"
import { useLiveQuery } from "@tanstack/react-db"
import { ROOM_TTL_SECONDS } from "../utils/schemas"
import { useRegistryContext } from "./registry-context"
import type { RoomMetadata } from "../utils/schemas"

const PALETTE = {
  bg: `#0B0E17`,
  card: `#0E1225`,
  border: `#1A1F38`,
  text: `#8892B0`,
  accent: `#00E5FF`,
  food: `#FF3D71`,
  dim: `#444`,
}

const BOARD_SIZES = [
  { label: `Small (20x16)`, cols: 20, rows: 16 },
  { label: `Medium (30x24)`, cols: 30, rows: 24 },
  { label: `Large (40x30)`, cols: 40, rows: 30 },
]

const SPEED_OPTIONS = [
  { label: `Chill`, tick: 220 },
  { label: `Normal`, tick: 180 },
  { label: `Fast`, tick: 120 },
  { label: `Insane`, tick: 80 },
]

interface LobbyProps {
  playerName: string
  onPlayerNameChange: (name: string) => void
  onJoinRoom: (roomId: string) => void
}

export function Lobby({
  playerName,
  onPlayerNameChange,
  onJoinRoom,
}: LobbyProps) {
  const { registryDB } = useRegistryContext()
  const [roomName, setRoomName] = useState(``)
  const [sizeIdx, setSizeIdx] = useState(1) // default Medium
  const [speedIdx, setSpeedIdx] = useState(1) // default Normal
  const [isCreating, setIsCreating] = useState(false)
  const [roomPage, setRoomPage] = useState(0)

  // Tick every second so countdowns update
  const [, setTick] = useState(0)
  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 1000)
    return () => clearInterval(interval)
  }, [])

  const { data: rooms = [] } = useLiveQuery((q) =>
    q.from({ rooms: registryDB.collections.rooms })
  )

  // Filter out expired rooms and sort by creation time
  const now = Date.now()
  const activeRooms = rooms.filter((r) => r.expiresAt > now)
  const sortedRooms = [...activeRooms].sort((a, b) => b.createdAt - a.createdAt)

  const createRoom = async () => {
    if (isCreating) return
    setIsCreating(true)
    try {
      const name =
        roomName.trim() || `room-${Math.random().toString(36).slice(2, 7)}`
      const size = BOARD_SIZES[sizeIdx]
      const speed = SPEED_OPTIONS[speedIdx]
      const roomId = `${name}__${size.cols}x${size.rows}_${speed.tick}ms`

      const createdAt = Date.now()
      const metadata: RoomMetadata = {
        roomId,
        name,
        boardSize: `${size.cols}x${size.rows} · ${speed.label}`,
        createdAt,
        expiresAt: createdAt + ROOM_TTL_SECONDS * 1000,
      }

      await registryDB.actions.addRoom(metadata)
      setRoomName(``)
      onJoinRoom(roomId)
    } catch (err) {
      console.error(`Failed to create room:`, err)
    } finally {
      setIsCreating(false)
    }
  }

  return (
    <div style={styles.container}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700;800&display=swap');
      `}</style>

      <div style={styles.title}>SNAKE</div>
      <div style={styles.subtitle}>Multiplayer with Durable Streams</div>

      {/* Player Name */}
      <div style={styles.card}>
        <div style={styles.cardTitle}>Your Name</div>
        <input
          style={styles.input}
          value={playerName}
          onChange={(e) => onPlayerNameChange(e.target.value)}
          placeholder="Enter your name..."
          maxLength={20}
        />
      </div>

      {/* Create Room */}
      <div style={styles.card}>
        <div style={styles.cardTitle}>Create Room</div>

        <label style={styles.label}>Room Name (optional)</label>
        <input
          style={styles.input}
          value={roomName}
          onChange={(e) => setRoomName(e.target.value)}
          placeholder="my-room"
          onKeyDown={(e) => e.key === `Enter` && createRoom()}
        />

        <label style={styles.label}>Board Size</label>
        <div style={styles.sizeRow}>
          {BOARD_SIZES.map((s, i) => (
            <button
              key={s.label}
              style={{
                ...styles.sizeBtn,
                ...(i === sizeIdx ? styles.sizeBtnActive : {}),
              }}
              onClick={() => setSizeIdx(i)}
            >
              {s.label}
            </button>
          ))}
        </div>

        <label style={styles.label}>Speed</label>
        <div style={styles.sizeRow}>
          {SPEED_OPTIONS.map((s, i) => (
            <button
              key={s.label}
              style={{
                ...styles.sizeBtn,
                ...(i === speedIdx ? styles.sizeBtnActive : {}),
              }}
              onClick={() => setSpeedIdx(i)}
            >
              {s.label}
            </button>
          ))}
        </div>

        <button
          style={{ ...styles.createBtn, opacity: isCreating ? 0.6 : 1 }}
          onClick={createRoom}
          disabled={isCreating}
        >
          {isCreating ? `CREATING...` : `CREATE & JOIN`}
        </button>
      </div>

      {/* Active Rooms */}
      <div style={styles.card}>
        <div style={styles.cardTitle}>Active Rooms</div>
        {sortedRooms.length === 0 ? (
          <div
            style={{
              fontSize: 10,
              color: PALETTE.dim,
              textAlign: `center`,
              padding: `12px 0`,
            }}
          >
            No active rooms. Create one to get started.
          </div>
        ) : (
          <>
            <div style={{ display: `flex`, flexDirection: `column`, gap: 6 }}>
              {sortedRooms.slice(roomPage * 5, roomPage * 5 + 5).map((room) => (
                <RoomItem
                  key={room.roomId}
                  room={room}
                  onJoin={() => onJoinRoom(room.roomId)}
                />
              ))}
            </div>
            {sortedRooms.length > 5 && (
              <div
                style={{
                  display: `flex`,
                  justifyContent: `center`,
                  gap: 8,
                  marginTop: 10,
                }}
              >
                <button
                  style={{
                    ...styles.sizeBtn,
                    width: 28,
                    padding: `4px 0`,
                    opacity: roomPage === 0 ? 0.3 : 1,
                  }}
                  disabled={roomPage === 0}
                  onClick={() => setRoomPage((p) => p - 1)}
                >
                  ←
                </button>
                <span
                  style={{
                    fontSize: 9,
                    color: PALETTE.dim,
                    lineHeight: `24px`,
                  }}
                >
                  {roomPage + 1}/{Math.ceil(sortedRooms.length / 5)}
                </span>
                <button
                  style={{
                    ...styles.sizeBtn,
                    width: 28,
                    padding: `4px 0`,
                    opacity:
                      roomPage >= Math.ceil(sortedRooms.length / 5) - 1
                        ? 0.3
                        : 1,
                  }}
                  disabled={roomPage >= Math.ceil(sortedRooms.length / 5) - 1}
                  onClick={() => setRoomPage((p) => p + 1)}
                >
                  →
                </button>
              </div>
            )}
          </>
        )}
      </div>

      <div style={styles.hint}>
        Share the page URL with friends to play together. Rooms are
        automatically deleted when all players leave.
      </div>
    </div>
  )
}

function RoomItem({
  room,
  onJoin,
}: {
  room: RoomMetadata
  onJoin: () => void
}) {
  const count = room.playerCount ?? 0
  const remaining = Math.max(0, room.expiresAt - Date.now())
  const mins = Math.floor(remaining / 60000)
  const secs = Math.floor((remaining % 60000) / 1000)
  const timeLeft = `${mins}:${secs.toString().padStart(2, `0`)}`
  const isLow = remaining < 120_000 // less than 2 min

  return (
    <div
      style={{
        display: `flex`,
        alignItems: `center`,
        justifyContent: `space-between`,
        background: PALETTE.bg,
        border: `1px solid ${PALETTE.border}`,
        borderRadius: 4,
        padding: `8px 12px`,
        cursor: `pointer`,
      }}
      onClick={onJoin}
    >
      <div style={{ display: `flex`, flexDirection: `column`, gap: 2 }}>
        <div style={{ display: `flex`, alignItems: `center`, gap: 6 }}>
          <span style={{ fontSize: 12, color: PALETTE.text, fontWeight: 600 }}>
            {room.name}
          </span>
          <span
            style={{
              fontSize: 9,
              color: count > 0 ? PALETTE.accent : PALETTE.dim,
              fontWeight: 700,
              background: count > 0 ? `#0A2A3A` : `transparent`,
              padding: `1px 6px`,
              borderRadius: 8,
            }}
          >
            {count} player{count !== 1 ? `s` : ``}
          </span>
        </div>
        <span style={{ fontSize: 9, color: PALETTE.dim }}>
          {room.boardSize} ·{` `}
          <span style={{ color: isLow ? PALETTE.food : PALETTE.dim }}>
            {timeLeft} left
          </span>
        </span>
      </div>
      <button
        style={{
          background: PALETTE.accent,
          color: `#000`,
          border: `none`,
          fontFamily: `inherit`,
          fontSize: 10,
          fontWeight: 700,
          padding: `4px 14px`,
          borderRadius: 4,
          cursor: `pointer`,
          letterSpacing: 1,
        }}
        onClick={(e) => {
          e.stopPropagation()
          onJoin()
        }}
      >
        JOIN
      </button>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: `flex`,
    flexDirection: `column`,
    alignItems: `center`,
    justifyContent: `center`,
    minHeight: `100vh`,
    fontFamily: `'JetBrains Mono', 'SF Mono', monospace`,
    background: PALETTE.bg,
    color: PALETTE.text,
    padding: 24,
  },
  title: {
    fontSize: 32,
    fontWeight: 800,
    letterSpacing: 8,
    color: PALETTE.accent,
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 11,
    color: PALETTE.dim,
    marginBottom: 32,
  },
  card: {
    background: PALETTE.card,
    border: `1px solid ${PALETTE.border}`,
    borderRadius: 8,
    padding: 20,
    width: 380,
    marginBottom: 16,
  },
  cardTitle: {
    fontSize: 12,
    fontWeight: 700,
    color: PALETTE.accent,
    letterSpacing: 2,
    marginBottom: 12,
  },
  label: {
    fontSize: 9,
    color: PALETTE.dim,
    display: `block`,
    marginBottom: 4,
    letterSpacing: 1,
  },
  input: {
    width: `100%`,
    background: PALETTE.bg,
    border: `1px solid ${PALETTE.border}`,
    borderRadius: 4,
    padding: `8px 12px`,
    color: PALETTE.text,
    fontFamily: `inherit`,
    fontSize: 12,
    marginBottom: 12,
    outline: `none`,
  },
  sizeRow: {
    display: `flex`,
    gap: 6,
    marginBottom: 16,
  },
  sizeBtn: {
    flex: 1,
    padding: `6px 4px`,
    fontSize: 9,
    fontFamily: `inherit`,
    background: PALETTE.bg,
    color: PALETTE.dim,
    border: `1px solid ${PALETTE.border}`,
    borderRadius: 4,
    cursor: `pointer`,
  },
  sizeBtnActive: {
    background: `#0A2A3A`,
    color: PALETTE.accent,
    borderColor: PALETTE.accent,
  },
  createBtn: {
    width: `100%`,
    padding: `10px 0`,
    fontSize: 12,
    fontWeight: 700,
    fontFamily: `inherit`,
    background: PALETTE.accent,
    color: `#000`,
    border: `none`,
    borderRadius: 4,
    cursor: `pointer`,
    letterSpacing: 2,
    marginTop: 4,
  },
  hint: {
    fontSize: 9,
    color: `#333`,
    textAlign: `center`,
    maxWidth: 360,
    lineHeight: 1.6,
    marginTop: 8,
  },
}
