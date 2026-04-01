import { useEffect, useState } from "react"
import { useLiveQuery } from "@tanstack/react-db"
import { ROOM_TTL_SECONDS } from "../utils/schemas"
import { useRegistryContext } from "./registry-context"
import type { RoomMetadata } from "../utils/schemas"

const PALETTE = {
  bg: `#1b1b1f`,
  card: `#161618`,
  border: `#2e2e32`,
  text: `rgba(235,235,245,0.68)`,
  accent: `#d0bcff`,
  dim: `rgba(235,235,245,0.38)`,
}

const BOARD_SIZES = [
  { label: `32x32`, cols: 32, rows: 32 },
  { label: `64x64`, cols: 64, rows: 64 },
  { label: `128x128`, cols: 128, rows: 128 },
]

function buildRoomId(
  name: string,
  size: { cols: number; rows: number }
): string {
  return `${name}__${size.cols}x${size.rows}`
}

function randomRoomName(): string {
  const words = [
    `neon`,
    `cyber`,
    `pixel`,
    `hyper`,
    `turbo`,
    `mega`,
    `ultra`,
    `nova`,
  ]
  const word = words[Math.floor(Math.random() * words.length)]
  const num = Math.floor(Math.random() * 900) + 100
  return `${word}-${num}`
}

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
  const [roomName, setRoomName] = useState(randomRoomName)
  const [sizeIdx, setSizeIdx] = useState(1)
  const [isCreating, setIsCreating] = useState(false)
  const [roomPage, setRoomPage] = useState(0)
  const [joinRoomId, setJoinRoomId] = useState(``)

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
      const roomId = buildRoomId(name, size)

      const createdAt = Date.now()
      const metadata: RoomMetadata = {
        roomId,
        name,
        boardSize: `${size.cols}x${size.rows}`,
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
        @import url('https://fonts.googleapis.com/css2?family=Press+Start+2P&display=swap');
        .lobby-btn:active { opacity: 0.7; }
      `}</style>

      <div style={styles.title}>TERRITORY WARS</div>
      <div
        style={{
          fontSize: 7,
          color: PALETTE.dim,
          marginBottom: 20,
          textAlign: `center`,
          maxWidth: 340,
          lineHeight: 1.6,
        }}
      >
        Claim 30% territory or lead when time runs out.
      </div>

      {/* Player Name */}
      <div style={styles.card}>
        <div style={styles.cardTitle}>NAME</div>
        <input
          style={styles.input}
          value={playerName}
          onChange={(e) => onPlayerNameChange(e.target.value)}
          placeholder="Enter your name..."
          maxLength={20}
        />
      </div>

      {/* Room */}
      <div style={styles.card}>
        <div style={styles.cardTitle}>ROOM</div>

        <input
          style={styles.input}
          value={roomName}
          onChange={(e) => setRoomName(e.target.value)}
          placeholder="room name"
          onKeyDown={(e) => e.key === `Enter` && createRoom()}
        />

        <div style={styles.cardTitle}>BOARD SIZE</div>
        <div style={{ display: `flex`, gap: 6, marginBottom: 10 }}>
          {BOARD_SIZES.map((size, i) => (
            <button
              key={size.label}
              className="lobby-btn"
              style={{
                flex: 1,
                padding: `6px 0`,
                fontSize: 7,
                fontFamily: `inherit`,
                background: i === sizeIdx ? PALETTE.accent : `transparent`,
                color: i === sizeIdx ? `#000` : PALETTE.accent,
                border: `1px solid ${PALETTE.accent}`,
                cursor: `pointer`,
                letterSpacing: 1,
              }}
              onClick={() => setSizeIdx(i)}
            >
              {size.label}
            </button>
          ))}
        </div>

        <button
          className="lobby-btn"
          style={{
            ...styles.createBtn,
            opacity: isCreating ? 0.6 : 1,
          }}
          onClick={createRoom}
          disabled={isCreating}
        >
          {isCreating ? `STARTING...` : `START`}
        </button>
      </div>

      {/* Rooms */}
      <div style={styles.card}>
        <div style={styles.cardTitle}>ROOMS</div>
        <div style={{ display: `flex`, flexDirection: `column`, gap: 6 }}>
          {sortedRooms.slice(roomPage * 3, roomPage * 3 + 3).map((room) => (
            <RoomItem
              key={room.roomId}
              room={room}
              onJoin={() => onJoinRoom(room.roomId)}
            />
          ))}
          {/* Join by room ID — last row, same style as RoomItem */}
          <div
            style={{
              display: `flex`,
              alignItems: `center`,
              justifyContent: `space-between`,
              background: PALETTE.bg,
              border: `1px solid ${PALETTE.border}`,
              padding: `8px 12px`,
            }}
          >
            <input
              style={{
                fontSize: 8,
                color: PALETTE.text,
                fontFamily: `inherit`,
                background: `transparent`,
                border: `none`,
                outline: `none`,
                flex: 1,
                padding: 0,
              }}
              value={joinRoomId}
              onChange={(e) => setJoinRoomId(e.target.value)}
              placeholder="room-id"
              onKeyDown={(e) => {
                if (e.key === `Enter` && joinRoomId.trim()) {
                  const existing = sortedRooms.find(
                    (r) => r.name === joinRoomId.trim()
                  )
                  onJoinRoom(
                    existing
                      ? existing.roomId
                      : buildRoomId(joinRoomId.trim(), BOARD_SIZES[sizeIdx])
                  )
                }
              }}
            />
            {joinRoomId.trim() && (
              <button
                className="lobby-btn"
                style={{
                  background: PALETTE.accent,
                  color: `#000`,
                  border: `none`,
                  fontFamily: `inherit`,
                  fontSize: 7,
                  padding: `4px 12px`,
                  cursor: `pointer`,
                  letterSpacing: 1,
                  flexShrink: 0,
                }}
                onClick={() => {
                  const existing = sortedRooms.find(
                    (r) => r.name === joinRoomId.trim()
                  )
                  onJoinRoom(
                    existing
                      ? existing.roomId
                      : buildRoomId(joinRoomId.trim(), BOARD_SIZES[sizeIdx])
                  )
                }}
              >
                JOIN
              </button>
            )}
          </div>
        </div>
        {sortedRooms.length > 3 && (
          <div
            style={{
              display: `flex`,
              justifyContent: `center`,
              gap: 8,
              marginTop: 10,
            }}
          >
            <button
              className="lobby-btn"
              style={{
                fontFamily: `inherit`,
                fontSize: 6,
                background: PALETTE.bg,
                color: PALETTE.dim,
                border: `1px solid ${PALETTE.border}`,
                cursor: `pointer`,
                width: 28,
                padding: `4px 0`,
                opacity: roomPage === 0 ? 0.3 : 1,
              }}
              disabled={roomPage === 0}
              onClick={() => setRoomPage((p) => p - 1)}
            >
              &lt;
            </button>
            <span
              style={{
                fontSize: 7,
                color: PALETTE.dim,
                lineHeight: `24px`,
              }}
            >
              {roomPage + 1}/{Math.ceil(sortedRooms.length / 3)}
            </span>
            <button
              className="lobby-btn"
              style={{
                fontFamily: `inherit`,
                fontSize: 6,
                background: PALETTE.bg,
                color: PALETTE.dim,
                border: `1px solid ${PALETTE.border}`,
                cursor: `pointer`,
                width: 28,
                padding: `4px 0`,
                opacity:
                  roomPage >= Math.ceil(sortedRooms.length / 3) - 1 ? 0.3 : 1,
              }}
              disabled={roomPage >= Math.ceil(sortedRooms.length / 3) - 1}
              onClick={() => setRoomPage((p) => p + 1)}
            >
              &gt;
            </button>
          </div>
        )}
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
  const [copied, setCopied] = useState(false)

  const copyName = (e: React.MouseEvent) => {
    e.stopPropagation()
    navigator.clipboard.writeText(room.name).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }

  return (
    <div
      style={{
        display: `flex`,
        alignItems: `center`,
        justifyContent: `space-between`,
        background: PALETTE.bg,
        border: `1px solid ${PALETTE.border}`,
        padding: `8px 12px`,
        cursor: `pointer`,
      }}
      onClick={onJoin}
    >
      <div
        style={{ display: `flex`, alignItems: `center`, gap: 6 }}
        onClick={copyName}
        title="Click to copy room name"
      >
        <span
          style={{
            fontSize: 8,
            color: copied ? PALETTE.accent : PALETTE.text,
            cursor: `pointer`,
          }}
        >
          {copied ? `COPIED` : room.name}
        </span>
      </div>
      <button
        className="lobby-btn"
        style={{
          background: PALETTE.accent,
          color: `#000`,
          border: `none`,
          fontFamily: `inherit`,
          fontSize: 7,
          padding: `4px 12px`,
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
    fontFamily: `'Press Start 2P', monospace`,
    background: PALETTE.bg,
    color: PALETTE.text,
    padding: 20,
  },
  title: {
    fontSize: 16,
    letterSpacing: 4,
    color: PALETTE.accent,
    marginBottom: 6,
  },
  card: {
    background: PALETTE.card,
    border: `1px solid ${PALETTE.border}`,
    padding: 16,
    width: `100%`,
    maxWidth: 340,
    marginBottom: 12,
  },
  cardTitle: {
    fontSize: 7,
    color: PALETTE.accent,
    letterSpacing: 2,
    marginBottom: 10,
  },
  input: {
    width: `100%`,
    background: PALETTE.bg,
    border: `1px solid ${PALETTE.border}`,
    padding: `8px 10px`,
    color: PALETTE.text,
    fontFamily: `inherit`,
    fontSize: 8,
    marginBottom: 10,
    outline: `none`,
    boxSizing: `border-box`,
  },
  createBtn: {
    width: `100%`,
    padding: `10px 0`,
    fontSize: 8,
    fontFamily: `inherit`,
    background: PALETTE.accent,
    color: `#000`,
    border: `none`,
    cursor: `pointer`,
    letterSpacing: 2,
  },
}
