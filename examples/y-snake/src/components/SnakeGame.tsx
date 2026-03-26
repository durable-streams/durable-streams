import { useCallback, useEffect, useRef, useState } from "react"
import { useLiveQuery } from "@tanstack/react-db"
import { useGameRoom } from "./game-room-context"
import { useRoomScores } from "./scores-context"
import type * as Y from "yjs"

// ============================================================================
// Constants
// ============================================================================

const CELL = 20
const DEFAULT_TICK = 180
const OBSTACLE_INTERVAL = 20
const OBS_MIN_DIST = 4
const OBS_MAX_DIST = 10
const MAX_OBSTACLES = 20
const POINTS_FOOD = 10

const PALETTE = {
  bg: `#0B0E17`,
  grid: `#0F1322`,
  gridLine: `#151A2E`,
  snake: `#00E5FF`,
  snakeHead: `#00FFF7`,
  snakeGlow: `rgba(0,229,255,0.25)`,
  food: `#FF3D71`,
  foodGlow: `rgba(255,61,113,0.3)`,
  obsWarn: `#FFD93D`,
  obsSolid: `#FF6B35`,
  text: `#8892B0`,
  accent: `#00E5FF`,
}

// ============================================================================
// Types
// ============================================================================

interface Point {
  x: number
  y: number
}

interface Obstacle extends Point {
  age: number
}

interface PlayerState {
  snake: Array<Point>
  dir: { dx: number; dy: number }
  score: number
  name: string
  color: string
  alive: boolean
}

interface SharedGameState {
  food: Point
  obstacles: Array<Obstacle>
  tick: number
  cols: number
  rows: number
}

// ============================================================================
// Helpers
// ============================================================================

function rand(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function dist(x1: number, y1: number, x2: number, y2: number): number {
  return Math.abs(x1 - x2) + Math.abs(y1 - y2)
}

function parseRoomConfig(roomId: string): {
  cols: number
  rows: number
  baseTick: number
} {
  // Format: name__COLSxROWS or name__COLSxROWS_SPEEDms
  const match = roomId.match(/__(\d+)x(\d+)(?:_(\d+)ms)?$/)
  if (match) {
    return {
      cols: parseInt(match[1]),
      rows: parseInt(match[2]),
      baseTick: match[3] ? parseInt(match[3]) : DEFAULT_TICK,
    }
  }
  return { cols: 30, rows: 24, baseTick: DEFAULT_TICK }
}

function spawnFood(
  cols: number,
  rows: number,
  occupiedSet: Set<string>
): Point {
  let attempts = 0
  while (attempts < 500) {
    const x = rand(0, cols - 1)
    const y = rand(0, rows - 1)
    if (!occupiedSet.has(`${x},${y}`)) return { x, y }
    attempts++
  }
  return { x: 0, y: 0 }
}

function spawnObstacle(
  cols: number,
  rows: number,
  headX: number,
  headY: number,
  occupiedSet: Set<string>
): Obstacle | null {
  let attempts = 0
  while (attempts < 200) {
    const x = rand(0, cols - 1)
    const y = rand(0, rows - 1)
    const d = dist(headX, headY, x, y)
    if (
      d >= OBS_MIN_DIST &&
      d <= OBS_MAX_DIST &&
      !occupiedSet.has(`${x},${y}`)
    ) {
      return { x, y, age: 0 }
    }
    attempts++
  }
  return null
}

function buildOccupied(
  localSnake: Array<Point>,
  otherPlayers: Map<string, PlayerState>,
  obstacles: Array<Obstacle>,
  food: Point
): Set<string> {
  const set = new Set<string>()
  localSnake.forEach((s) => set.add(`${s.x},${s.y}`))
  otherPlayers.forEach((p) => {
    p.snake.forEach((s) => set.add(`${s.x},${s.y}`))
  })
  obstacles.forEach((o) => set.add(`${o.x},${o.y}`))
  set.add(`${food.x},${food.y}`)
  return set
}

const DIR_MAP: Record<string, { dx: number; dy: number }> = {
  ArrowUp: { dx: 0, dy: -1 },
  ArrowDown: { dx: 0, dy: 1 },
  ArrowLeft: { dx: -1, dy: 0 },
  ArrowRight: { dx: 1, dy: 0 },
  w: { dx: 0, dy: -1 },
  s: { dx: 0, dy: 1 },
  a: { dx: -1, dy: 0 },
  d: { dx: 1, dy: 0 },
}

// ============================================================================
// Yjs helpers: read/write shared state
// ============================================================================

function readSharedGame(
  doc: Y.Doc,
  cols: number,
  rows: number
): SharedGameState {
  const gameMap = doc.getMap(`game`)
  const food = (gameMap.get(`food`) as Point | undefined) || {
    x: Math.floor(cols / 2),
    y: 3,
  }
  const obstacles =
    (gameMap.get(`obstacles`) as Array<Obstacle> | undefined) || []
  const tick = (gameMap.get(`tick`) as number) || 0
  return { food, obstacles, tick, cols, rows }
}

function writeSharedGame(doc: Y.Doc, state: Partial<SharedGameState>) {
  const gameMap = doc.getMap(`game`)
  doc.transact(() => {
    if (state.food !== undefined) gameMap.set(`food`, state.food)
    if (state.obstacles !== undefined) gameMap.set(`obstacles`, state.obstacles)
    if (state.tick !== undefined) gameMap.set(`tick`, state.tick)
  })
}

function readPlayers(doc: Y.Doc, myId: string): Map<string, PlayerState> {
  const playersMap = doc.getMap(`players`)
  const result = new Map<string, PlayerState>()
  playersMap.forEach((val, key) => {
    if (key !== myId) {
      result.set(key, val as PlayerState)
    }
  })
  return result
}

function writeMyPlayer(doc: Y.Doc, playerId: string, state: PlayerState) {
  const playersMap = doc.getMap(`players`)
  playersMap.set(playerId, state)
}

function removeMyPlayer(doc: Y.Doc, playerId: string) {
  const playersMap = doc.getMap(`players`)
  playersMap.delete(playerId)
}

// ============================================================================
// SnakeGame component
// ============================================================================

interface SnakeGameProps {
  onLeave: () => void
}

export function SnakeGame({ onLeave }: SnakeGameProps) {
  const {
    doc,
    awareness,
    roomId,
    playerId,
    playerName,
    playerColor,
    expiresAt,
  } = useGameRoom()
  const { scoresDB, submitScoreIfHigher } = useRoomScores()
  const { cols, rows, baseTick } = parseRoomConfig(roomId)

  const [localSnake, setLocalSnake] = useState<Array<Point>>([])
  const [localDir, setLocalDir] = useState({ dx: 1, dy: 0 })
  const [localScore, setLocalScore] = useState(0)
  const [sharedState, setSharedState] = useState<SharedGameState>({
    food: { x: Math.floor(cols / 2), y: 3 },
    obstacles: [],
    tick: 0,
    cols,
    rows,
  })
  const [otherPlayers, setOtherPlayers] = useState<Map<string, PlayerState>>(
    new Map()
  )
  const [awarenessStates, setAwarenessStates] = useState<Map<number, any>>(
    new Map()
  )
  const [copied, setCopied] = useState(false)

  // Countdown timer — tick every second
  const [timeLeft, setTimeLeft] = useState(() =>
    Math.max(0, expiresAt - Date.now())
  )
  useEffect(() => {
    const interval = setInterval(() => {
      setTimeLeft(Math.max(0, expiresAt - Date.now()))
    }, 1000)
    return () => clearInterval(interval)
  }, [expiresAt])

  // High scores from StreamDB
  const { data: highScores = [] } = useLiveQuery(
    (q) => (scoresDB ? q.from({ scores: scoresDB.collections.scores }) : null),
    [scoresDB]
  )
  // Merge persisted high scores with live player scores (show whichever is higher)
  const mergedHighScores = (() => {
    const byName = new Map<
      string,
      { playerName: string; score: number; live: boolean }
    >()

    // Start with persisted scores
    for (const entry of highScores) {
      byName.set(entry.playerName, {
        playerName: entry.playerName,
        score: entry.score,
        live: false,
      })
    }

    // Overlay live scores if they're higher
    const livePlayers: Array<{ name: string; score: number }> = [
      { name: playerName, score: localScore },
    ]
    otherPlayers.forEach((p) =>
      livePlayers.push({ name: p.name, score: p.score })
    )

    for (const p of livePlayers) {
      if (p.score <= 0) continue
      const existing = byName.get(p.name)
      if (!existing || p.score > existing.score) {
        byName.set(p.name, { playerName: p.name, score: p.score, live: true })
      }
    }

    return [...byName.values()].sort((a, b) => b.score - a.score).slice(0, 10)
  })()

  const dirQueue = useRef<Array<{ dx: number; dy: number }>>([])
  const localRef = useRef({
    snake: [] as Array<Point>,
    dir: { dx: 1, dy: 0 },
    score: 0,
    obstacleTimer: OBSTACLE_INTERVAL,
    speed: baseTick,
  })

  // Initialize player snake
  const initSnake = useCallback((): Array<Point> => {
    const startX = rand(3, cols - 4)
    const startY = rand(3, rows - 4)
    return [
      { x: startX, y: startY },
      { x: startX - 1, y: startY },
      { x: startX - 2, y: startY },
    ]
  }, [cols, rows])

  // Init game
  useEffect(() => {
    const snake = initSnake()
    setLocalSnake(snake)
    setLocalDir({ dx: 1, dy: 0 })
    setLocalScore(0)
    localRef.current = {
      snake,
      dir: { dx: 1, dy: 0 },
      score: 0,
      obstacleTimer: OBSTACLE_INTERVAL,
      speed: baseTick,
    }

    // Write initial state to Yjs
    writeMyPlayer(doc, playerId, {
      snake,
      dir: { dx: 1, dy: 0 },
      score: 0,
      name: playerName,
      color: playerColor,
      alive: true,
    })

    // Initialize shared game state if we're the first player
    const gameMap = doc.getMap(`game`)
    if (!gameMap.has(`food`)) {
      writeSharedGame(doc, {
        food: { x: rand(0, cols - 1), y: rand(0, rows - 1) },
        obstacles: [],
        tick: 0,
      })
    }

    return () => {
      removeMyPlayer(doc, playerId)
    }
  }, [doc, playerId, playerName, playerColor, cols, rows, initSnake])

  // Observe shared game state changes from Yjs
  useEffect(() => {
    const gameMap = doc.getMap(`game`)
    const handler = () => {
      setSharedState(readSharedGame(doc, cols, rows))
    }
    gameMap.observe(handler)
    // Initial read
    handler()
    return () => gameMap.unobserve(handler)
  }, [doc, cols, rows])

  // Observe other players
  useEffect(() => {
    const playersMap = doc.getMap(`players`)
    const handler = () => {
      setOtherPlayers(readPlayers(doc, playerId))
    }
    playersMap.observe(handler)
    handler()
    return () => playersMap.unobserve(handler)
  }, [doc, playerId])

  // Observe awareness for player presence — clean up Yjs players when awareness expires
  useEffect(() => {
    const handler = () => {
      const states = new Map<number, any>()
      const activePlayerIds = new Set<string>()

      awareness.getStates().forEach((state, clientId) => {
        if (clientId !== awareness.clientID) {
          states.set(clientId, state)
          if (state.playerId) activePlayerIds.add(state.playerId)
        }
      })
      setAwarenessStates(states)

      // Remove Yjs player entries for players whose awareness has timed out
      const playersMap = doc.getMap(`players`)
      playersMap.forEach((_, key) => {
        if (key !== playerId && !activePlayerIds.has(key)) {
          playersMap.delete(key)
        }
      })
    }
    awareness.on(`change`, handler)
    handler()
    return () => awareness.off(`change`, handler)
  }, [awareness, doc, playerId])

  // Keyboard input
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key in DIR_MAP) {
        e.preventDefault()
        dirQueue.current.push(DIR_MAP[e.key])
      }
    }
    window.addEventListener(`keydown`, handleKey)
    return () => window.removeEventListener(`keydown`, handleKey)
  }, [])

  // Respawn helper — resets snake and submits high score
  const respawn = useCallback(
    (finalScore: number) => {
      // Submit high score asynchronously
      if (finalScore > 0) {
        submitScoreIfHigher(playerName, finalScore)
      }

      const snake = initSnake()
      const dir = { dx: 1, dy: 0 }
      localRef.current = {
        snake,
        dir,
        score: 0,
        obstacleTimer: OBSTACLE_INTERVAL,
        speed: baseTick,
      }
      dirQueue.current = []
      setLocalSnake(snake)
      setLocalDir(dir)
      setLocalScore(0)
      writeMyPlayer(doc, playerId, {
        snake,
        dir,
        score: 0,
        name: playerName,
        color: playerColor,
        alive: true,
      })
    },
    [doc, playerId, playerName, playerColor, initSnake, submitScoreIfHigher]
  )

  // Game loop — uses recursive setTimeout so speed changes take effect each tick
  useEffect(() => {
    let timeoutId: ReturnType<typeof setTimeout>
    let cancelled = false
    const isCancelled = () => cancelled

    const tick = () => {
      if (isCancelled()) return

      const ref = localRef.current
      const snake = ref.snake.map((p) => ({ ...p }))
      let dir = { ...ref.dir }
      let score = ref.score
      let obstacleTimer = ref.obstacleTimer - 1

      // Process direction queue
      while (dirQueue.current.length > 0) {
        const newDir = dirQueue.current.shift()!
        if (newDir.dx !== -dir.dx || newDir.dy !== -dir.dy) {
          if (newDir.dx !== dir.dx || newDir.dy !== dir.dy) {
            dir = newDir
            break
          }
        }
      }

      // Move head
      const head = snake[0]
      let nx = head.x + dir.dx
      let ny = head.y + dir.dy

      // Wrap around walls instead of dying
      if (nx < 0) nx = cols - 1
      else if (nx >= cols) nx = 0
      if (ny < 0) ny = rows - 1
      else if (ny >= rows) ny = 0

      // Check self-collision (exclude tail — it moves away this tick)
      const selfHit = snake
        .slice(0, -1)
        .some((seg) => seg.x === nx && seg.y === ny)

      // Read shared state
      const sharedGame = readSharedGame(doc, cols, rows)
      let currentObstacles = sharedGame.obstacles.map((o) => ({ ...o }))

      // Check obstacle hit (solid only, age >= 3)
      const obsHit = currentObstacles.some(
        (o) => o.x === nx && o.y === ny && o.age >= 3
      )

      // Check other snake hits
      const others = readPlayers(doc, playerId)
      const otherHit = Array.from(others.values()).some(
        (p) => p.alive && p.snake.some((seg) => seg.x === nx && seg.y === ny)
      )

      // Lethal collisions — respawn immediately
      if (selfHit || obsHit || otherHit) {
        respawn(score)
        if (!isCancelled()) timeoutId = setTimeout(tick, baseTick)
        return
      }

      snake.unshift({ x: nx, y: ny })

      // Eat food
      let foodChanged = false
      let newFood = sharedGame.food
      if (nx === sharedGame.food.x && ny === sharedGame.food.y) {
        score += POINTS_FOOD
        const occupied = buildOccupied(
          snake,
          others,
          currentObstacles,
          sharedGame.food
        )
        newFood = spawnFood(cols, rows, occupied)
        foodChanged = true
      } else {
        snake.pop()
      }

      // Obstacle manager: age, spawn, and remove old — all in one write
      const allPlayerIds = [playerId]
      others.forEach((_, id) => allPlayerIds.push(id))
      allPlayerIds.sort()
      const isObstacleManager = allPlayerIds[0] === playerId

      let obstaclesChanged = false

      if (isObstacleManager) {
        // Age all obstacles
        currentObstacles = currentObstacles.map((o) => ({
          ...o,
          age: o.age + 1,
        }))
        // Remove expired
        currentObstacles = currentObstacles.filter((o) => o.age < 200)
        obstaclesChanged = true

        // Spawn new obstacle
        if (obstacleTimer <= 0 && currentObstacles.length < MAX_OBSTACLES) {
          obstacleTimer = Math.max(
            10,
            OBSTACLE_INTERVAL - Math.floor(score / 80)
          )
          const occupied = buildOccupied(
            snake,
            others,
            currentObstacles,
            newFood
          )
          const obs = spawnObstacle(
            cols,
            rows,
            snake[0].x,
            snake[0].y,
            occupied
          )
          if (obs) {
            currentObstacles.push(obs)
          }
        }
      }

      // Single batched write for all shared state changes
      if (obstaclesChanged || foodChanged) {
        const update: Partial<SharedGameState> = {}
        if (obstaclesChanged) update.obstacles = currentObstacles
        if (foodChanged) update.food = newFood
        writeSharedGame(doc, update)
      }

      // Speed up slightly
      const newSpeed = Math.max(60, baseTick - Math.floor(score / 20))

      Object.assign(ref, { snake, dir, score, obstacleTimer, speed: newSpeed })
      setLocalSnake([...snake])
      setLocalDir({ ...dir })
      setLocalScore(score)

      // Write player state to Yjs
      writeMyPlayer(doc, playerId, {
        snake,
        dir,
        score,
        name: playerName,
        color: playerColor,
        alive: true,
      })

      // Schedule next tick with current speed
      if (!isCancelled()) timeoutId = setTimeout(tick, ref.speed)
    }

    timeoutId = setTimeout(tick, localRef.current.speed)

    return () => {
      cancelled = true
      clearTimeout(timeoutId)
    }
  }, [doc, playerId, playerName, playerColor, cols, rows, baseTick, respawn])

  // ============================================================================
  // Render
  // ============================================================================

  const W = cols * CELL
  const H = rows * CELL

  // Build scoreboard from all players
  const allScores: Array<{
    name: string
    score: number
    color: string
    isMe: boolean
  }> = [{ name: playerName, score: localScore, color: playerColor, isMe: true }]
  otherPlayers.forEach((p) => {
    allScores.push({
      name: p.name,
      score: p.score,
      color: p.color,
      isMe: false,
    })
  })
  allScores.sort((a, b) => b.score - a.score)

  // Count connected players from awareness
  const connectedCount = awarenessStates.size + 1

  return (
    <div
      style={{
        display: `flex`,
        flexDirection: `column`,
        alignItems: `center`,
        fontFamily: `'JetBrains Mono', 'SF Mono', monospace`,
        background: PALETTE.bg,
        color: PALETTE.text,
        minHeight: `100vh`,
        padding: `12px`,
        boxSizing: `border-box`,
      }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700;800&display=swap');
        @keyframes warnPulse { 0%,100% { opacity:0.3 } 50% { opacity:0.9 } }
        @keyframes spawn { from { transform:scale(0);opacity:0 } to { transform:scale(1);opacity:1 } }
        @keyframes fadeOut { 0%,50% { opacity:0.8 } 100% { opacity:0.1 } }
      `}</style>

      {/* Header */}
      <div
        style={{
          display: `flex`,
          alignItems: `center`,
          gap: 12,
          marginBottom: 2,
        }}
      >
        <button
          onClick={onLeave}
          style={{
            background: `none`,
            border: `1px solid #1A1F38`,
            color: PALETTE.text,
            fontFamily: `inherit`,
            fontSize: 9,
            padding: `4px 10px`,
            borderRadius: 4,
            cursor: `pointer`,
          }}
        >
          ← LOBBY
        </button>
        <div
          style={{
            fontSize: 15,
            fontWeight: 800,
            letterSpacing: 4,
            color: PALETTE.accent,
          }}
        >
          SNAKE
        </div>
        <div
          style={{ fontSize: 9, color: `#444`, cursor: `pointer` }}
          title="Click to copy room link"
          onClick={() => {
            navigator.clipboard.writeText(window.location.href).catch(() => {})
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          }}
        >
          Room: {roomId.replace(/__\d+x\d+(?:_\d+ms)?$/, ``)}
          {` `}
          {copied ? `✓ copied` : `📋`}
        </div>
        <div style={{ fontSize: 9, color: `#555` }}>
          {connectedCount} player{connectedCount !== 1 ? `s` : ``}
        </div>
        <div
          style={{
            fontSize: 9,
            fontWeight: 700,
            color: timeLeft < 120_000 ? `#FF3D71` : `#555`,
          }}
        >
          {Math.floor(timeLeft / 60000)}:
          {Math.floor((timeLeft % 60000) / 1000)
            .toString()
            .padStart(2, `0`)}
        </div>
      </div>

      <div style={{ fontSize: 8, color: `#333`, marginBottom: 8 }}>
        {cols}x{rows} board · Walls wrap · Obstacles & snakes = instant respawn
        · Food = +{POINTS_FOOD}pts
      </div>

      {/* Scoreboard */}
      <div
        style={{
          display: `flex`,
          gap: 16,
          marginBottom: 6,
          fontSize: 10,
          fontWeight: 600,
          background: `#0E1225`,
          padding: `6px 16px`,
          borderRadius: 8,
          border: `1px solid #1A1F38`,
          flexWrap: `wrap`,
        }}
      >
        {allScores.map((p, i) => (
          <span
            key={i}
            style={{ display: `flex`, alignItems: `center`, gap: 4 }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: `50%`,
                background: p.color,
                display: `inline-block`,
              }}
            />
            <span
              style={{ color: p.isMe ? `#fff` : PALETTE.text, fontSize: 10 }}
            >
              {p.name}
            </span>
            <span style={{ color: p.color, fontSize: 12, fontWeight: 800 }}>
              {p.score}
            </span>
            {i === 0 && allScores.length > 1 && (
              <span style={{ fontSize: 8, color: `#FFD93D` }}>★</span>
            )}
          </span>
        ))}
      </div>

      {/* Game board + High Scores side by side */}
      <div style={{ display: `flex`, gap: 12, alignItems: `flex-start` }}>
        {/* Game board */}
        <div style={{ position: `relative` }}>
          <svg
            width={W}
            height={H}
            viewBox={`0 0 ${W} ${H}`}
            style={{
              background: PALETTE.grid,
              borderRadius: 6,
              border: `2px solid ${PALETTE.gridLine}`,
            }}
          >
            {/* Grid */}
            {Array.from({ length: cols }, (_, i) => (
              <line
                key={`v${i}`}
                x1={i * CELL}
                y1={0}
                x2={i * CELL}
                y2={H}
                stroke={PALETTE.gridLine}
                strokeWidth={0.5}
              />
            ))}
            {Array.from({ length: rows }, (_, i) => (
              <line
                key={`h${i}`}
                x1={0}
                y1={i * CELL}
                x2={W}
                y2={i * CELL}
                stroke={PALETTE.gridLine}
                strokeWidth={0.5}
              />
            ))}

            {/* Food */}
            <circle
              cx={sharedState.food.x * CELL + CELL / 2}
              cy={sharedState.food.y * CELL + CELL / 2}
              r={CELL * 1.2}
              fill={PALETTE.foodGlow}
              opacity={0.4}
            />
            <circle
              cx={sharedState.food.x * CELL + CELL / 2}
              cy={sharedState.food.y * CELL + CELL / 2}
              r={CELL / 2 - 2}
              fill={PALETTE.food}
            />
            <circle
              cx={sharedState.food.x * CELL + CELL / 2 - 2}
              cy={sharedState.food.y * CELL + CELL / 2 - 2}
              r={2}
              fill="rgba(255,255,255,0.4)"
            />

            {/* Obstacles */}
            {sharedState.obstacles.map((o, i) => {
              const isWarning = o.age < 3
              const isFading = o.age >= 180 // starts fading 20 ticks before expiry (200)
              const cx = o.x * CELL + CELL / 2
              const cy = o.y * CELL + CELL / 2
              if (isWarning) {
                return (
                  <g key={`obs-${i}`}>
                    <rect
                      x={o.x * CELL + 2}
                      y={o.y * CELL + 2}
                      width={CELL - 4}
                      height={CELL - 4}
                      fill="none"
                      stroke={PALETTE.obsWarn}
                      strokeWidth={2}
                      rx={3}
                      strokeDasharray="4 2"
                      style={{
                        animation: `warnPulse 0.4s ease-in-out infinite`,
                      }}
                    />
                    <text
                      x={cx}
                      y={cy + 4}
                      textAnchor="middle"
                      fontSize={12}
                      fill={PALETTE.obsWarn}
                      fontWeight={800}
                      style={{
                        animation: `warnPulse 0.4s ease-in-out infinite`,
                      }}
                    >
                      !
                    </text>
                  </g>
                )
              }
              if (isFading) {
                return (
                  <g key={`obs-${i}`}>
                    <rect
                      x={o.x * CELL + 2}
                      y={o.y * CELL + 2}
                      width={CELL - 4}
                      height={CELL - 4}
                      fill="none"
                      stroke={PALETTE.obsSolid}
                      strokeWidth={2}
                      rx={3}
                      strokeDasharray="4 2"
                      style={{
                        animation: `warnPulse 0.4s ease-in-out infinite`,
                      }}
                    />
                    <line
                      x1={o.x * CELL + 6}
                      y1={o.y * CELL + 6}
                      x2={o.x * CELL + CELL - 6}
                      y2={o.y * CELL + CELL - 6}
                      stroke={PALETTE.obsSolid}
                      strokeWidth={1.5}
                      strokeLinecap="round"
                      opacity={0.4}
                      style={{
                        animation: `warnPulse 0.4s ease-in-out infinite`,
                      }}
                    />
                    <line
                      x1={o.x * CELL + CELL - 6}
                      y1={o.y * CELL + 6}
                      x2={o.x * CELL + 6}
                      y2={o.y * CELL + CELL - 6}
                      stroke={PALETTE.obsSolid}
                      strokeWidth={1.5}
                      strokeLinecap="round"
                      opacity={0.4}
                      style={{
                        animation: `warnPulse 0.4s ease-in-out infinite`,
                      }}
                    />
                  </g>
                )
              }
              return (
                <g key={`obs-${i}`}>
                  <rect
                    x={o.x * CELL + 1}
                    y={o.y * CELL + 1}
                    width={CELL - 2}
                    height={CELL - 2}
                    fill={PALETTE.obsSolid}
                    rx={3}
                    opacity={0.9}
                  />
                  <line
                    x1={o.x * CELL + 6}
                    y1={o.y * CELL + 6}
                    x2={o.x * CELL + CELL - 6}
                    y2={o.y * CELL + CELL - 6}
                    stroke="rgba(0,0,0,0.3)"
                    strokeWidth={2}
                    strokeLinecap="round"
                  />
                  <line
                    x1={o.x * CELL + CELL - 6}
                    y1={o.y * CELL + 6}
                    x2={o.x * CELL + 6}
                    y2={o.y * CELL + CELL - 6}
                    stroke="rgba(0,0,0,0.3)"
                    strokeWidth={2}
                    strokeLinecap="round"
                  />
                </g>
              )
            })}

            {/* Other players' snakes */}
            {Array.from(otherPlayers.entries()).map(([id, p]) => (
              <g key={`player-${id}`}>
                {p.snake.map((seg, i) => {
                  const isHead = i === 0
                  const progress = i / Math.max(p.snake.length, 1)
                  const alpha = 1 - progress * 0.6
                  const size = isHead ? CELL - 2 : CELL - 3 - progress * 3
                  const offset = (CELL - size) / 2
                  return (
                    <g key={`${id}-seg-${i}`}>
                      <rect
                        x={seg.x * CELL + offset}
                        y={seg.y * CELL + offset}
                        width={size}
                        height={size}
                        rx={isHead ? 5 : 3}
                        fill={p.color}
                        opacity={alpha * 0.7}
                      />
                      {isHead && (
                        <text
                          x={seg.x * CELL + CELL / 2}
                          y={seg.y * CELL - 3}
                          textAnchor="middle"
                          fontSize={7}
                          fill={p.color}
                          opacity={0.8}
                        >
                          {p.name}
                        </text>
                      )}
                    </g>
                  )
                })}
              </g>
            ))}

            {/* Local snake glow */}
            {localSnake.length > 0 && (
              <circle
                cx={localSnake[0].x * CELL + CELL / 2}
                cy={localSnake[0].y * CELL + CELL / 2}
                r={CELL * 1.5}
                fill={PALETTE.snakeGlow}
              />
            )}

            {/* Local snake */}
            {localSnake.map((seg, i) => {
              const isHead = i === 0
              const isTail = i === localSnake.length - 1
              const progress = i / Math.max(localSnake.length, 1)
              const alpha = 1 - progress * 0.6
              const size = isHead ? CELL - 2 : CELL - 3 - progress * 3
              const offset = (CELL - size) / 2
              return (
                <g key={`seg-${i}`}>
                  <rect
                    x={seg.x * CELL + offset}
                    y={seg.y * CELL + offset}
                    width={size}
                    height={size}
                    rx={isHead ? 5 : isTail ? 6 : 3}
                    fill={playerColor}
                    opacity={alpha}
                  />
                  {isHead && (
                    <>
                      {/* Eyes */}
                      {(() => {
                        const cx = seg.x * CELL + CELL / 2
                        const cy = seg.y * CELL + CELL / 2
                        const ex1 = cx + localDir.dy * 4 + localDir.dx * 3
                        const ey1 = cy - localDir.dx * 4 + localDir.dy * 3
                        const ex2 = cx - localDir.dy * 4 + localDir.dx * 3
                        const ey2 = cy + localDir.dx * 4 + localDir.dy * 3
                        return (
                          <>
                            <circle cx={ex1} cy={ey1} r={2.5} fill="#FFF" />
                            <circle cx={ex2} cy={ey2} r={2.5} fill="#FFF" />
                            <circle
                              cx={ex1 + localDir.dx * 0.8}
                              cy={ey1 + localDir.dy * 0.8}
                              r={1.3}
                              fill="#111"
                            />
                            <circle
                              cx={ex2 + localDir.dx * 0.8}
                              cy={ey2 + localDir.dy * 0.8}
                              r={1.3}
                              fill="#111"
                            />
                          </>
                        )
                      })()}
                      {/* Name label */}
                      <text
                        x={seg.x * CELL + CELL / 2}
                        y={seg.y * CELL - 3}
                        textAnchor="middle"
                        fontSize={7}
                        fill={playerColor}
                        fontWeight={700}
                      >
                        {playerName} (you)
                      </text>
                    </>
                  )}
                </g>
              )
            })}

            {/* Danger zone */}
            {localSnake.length > 0 && (
              <circle
                cx={localSnake[0].x * CELL + CELL / 2}
                cy={localSnake[0].y * CELL + CELL / 2}
                r={OBS_MAX_DIST * CELL}
                fill="none"
                stroke="rgba(255,107,53,0.06)"
                strokeWidth={1}
                strokeDasharray="4 6"
              />
            )}
          </svg>
        </div>

        {/* High Scores panel */}
        <div
          style={{
            background: `#0E1225`,
            border: `1px solid #1A1F38`,
            borderRadius: 8,
            padding: `10px 14px`,
            width: 160,
            flexShrink: 0,
          }}
        >
          <div
            style={{
              fontSize: 10,
              fontWeight: 700,
              color: PALETTE.accent,
              letterSpacing: 2,
              marginBottom: 8,
            }}
          >
            HIGH SCORES
          </div>
          {mergedHighScores.length === 0 ? (
            <div style={{ fontSize: 9, color: `#333` }}>No scores yet</div>
          ) : (
            mergedHighScores.map((entry, i) => (
              <div
                key={entry.playerName}
                style={{
                  display: `flex`,
                  justifyContent: `space-between`,
                  alignItems: `center`,
                  fontSize: 10,
                  padding: `3px 0`,
                  color:
                    entry.playerName === playerName ? `#fff` : PALETTE.text,
                }}
              >
                <span style={{ display: `flex`, gap: 4, alignItems: `center` }}>
                  <span
                    style={{
                      color: `#555`,
                      fontSize: 8,
                      width: 14,
                      textAlign: `right`,
                    }}
                  >
                    {i + 1}.
                  </span>
                  <span
                    style={{
                      maxWidth: 80,
                      overflow: `hidden`,
                      textOverflow: `ellipsis`,
                      whiteSpace: `nowrap`,
                    }}
                  >
                    {entry.playerName}
                  </span>
                  {entry.live && (
                    <span
                      style={{
                        fontSize: 6,
                        color: PALETTE.food,
                        fontWeight: 700,
                      }}
                    >
                      LIVE
                    </span>
                  )}
                </span>
                <span
                  style={{
                    fontWeight: 800,
                    color: entry.live ? PALETTE.food : PALETTE.accent,
                  }}
                >
                  {entry.score}
                </span>
              </div>
            ))
          )}
        </div>
      </div>

      <div
        style={{
          fontSize: 8,
          color: `#333`,
          marginTop: 8,
          textAlign: `center`,
          maxWidth: 500,
          lineHeight: 1.6,
        }}
      >
        Arrow keys or WASD to move. Walls wrap around. Obstacles and other
        snakes cause instant respawn. Eat food to grow and score points. Best
        scores are saved per room.
      </div>
    </div>
  )
}
