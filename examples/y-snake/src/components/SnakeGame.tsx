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
  bg: `#1b1b1f`,
  grid: `#202127`,
  gridLine: `#2e2e32`,
  snake: `#75fbfd`,
  snakeHead: `#75fbfd`,
  food: `#00d2a0`,
  obsWarn: `#f6f95c`,
  obsSolid: `#d0bcff`,
  text: `rgba(235,235,245,0.68)`,
  accent: `#d0bcff`,
  purple: `#998fe7`,
  dim: `rgba(235,235,245,0.38)`,
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
  const { doc, awareness, roomId, playerId, playerName, playerColor } =
    useGameRoom()
  const { scoresDB, submitScoreIfHigher } = useRoomScores()
  const { cols, rows, baseTick } = parseRoomConfig(roomId)

  const [localSnake, setLocalSnake] = useState<Array<Point>>([])
  const [, setLocalDir] = useState({ dx: 1, dy: 0 })
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

    for (const entry of highScores) {
      byName.set(entry.playerName, {
        playerName: entry.playerName,
        score: entry.score,
        live: false,
      })
    }

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

    writeMyPlayer(doc, playerId, {
      snake,
      dir: { dx: 1, dy: 0 },
      score: 0,
      name: playerName,
      color: playerColor,
      alive: true,
    })

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

  // Observe awareness for player presence
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

  // Respawn helper
  const respawn = useCallback(
    (finalScore: number) => {
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

  // Touch direction handler
  const handleDirection = useCallback((dx: number, dy: number) => {
    dirQueue.current.push({ dx, dy })
  }, [])

  // Game loop
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

      while (dirQueue.current.length > 0) {
        const newDir = dirQueue.current.shift()!
        if (newDir.dx !== -dir.dx || newDir.dy !== -dir.dy) {
          if (newDir.dx !== dir.dx || newDir.dy !== dir.dy) {
            dir = newDir
            break
          }
        }
      }

      const head = snake[0]
      let nx = head.x + dir.dx
      let ny = head.y + dir.dy

      if (nx < 0) nx = cols - 1
      else if (nx >= cols) nx = 0
      if (ny < 0) ny = rows - 1
      else if (ny >= rows) ny = 0

      const selfHit = snake
        .slice(0, -1)
        .some((seg) => seg.x === nx && seg.y === ny)

      const sharedGame = readSharedGame(doc, cols, rows)
      let currentObstacles = sharedGame.obstacles.map((o) => ({ ...o }))

      const obsHit = currentObstacles.some(
        (o) => o.x === nx && o.y === ny && o.age >= 3
      )

      const others = readPlayers(doc, playerId)
      const otherHit = Array.from(others.values()).some(
        (p) => p.alive && p.snake.some((seg) => seg.x === nx && seg.y === ny)
      )

      if (selfHit || obsHit || otherHit) {
        respawn(score)
        if (!isCancelled()) timeoutId = setTimeout(tick, baseTick)
        return
      }

      snake.unshift({ x: nx, y: ny })

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

      const allPlayerIds = [playerId]
      others.forEach((_, id) => allPlayerIds.push(id))
      allPlayerIds.sort()
      const isObstacleManager = allPlayerIds[0] === playerId

      let obstaclesChanged = false

      if (isObstacleManager) {
        currentObstacles = currentObstacles.map((o) => ({
          ...o,
          age: o.age + 1,
        }))
        currentObstacles = currentObstacles.filter((o) => o.age < 200)
        obstaclesChanged = true

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

      if (obstaclesChanged || foodChanged) {
        const update: Partial<SharedGameState> = {}
        if (obstaclesChanged) update.obstacles = currentObstacles
        if (foodChanged) update.food = newFood
        writeSharedGame(doc, update)
      }

      const newSpeed = Math.max(60, baseTick - Math.floor(score / 20))

      Object.assign(ref, { snake, dir, score, obstacleTimer, speed: newSpeed })
      setLocalSnake([...snake])
      setLocalDir({ ...dir })
      setLocalScore(score)

      writeMyPlayer(doc, playerId, {
        snake,
        dir,
        score,
        name: playerName,
        color: playerColor,
        alive: true,
      })

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

  const topScore = mergedHighScores.length > 0 ? mergedHighScores[0] : null
  const connectedCount = awarenessStates.size + 1

  return (
    <div
      style={{
        display: `flex`,
        flexDirection: `column`,
        alignItems: `center`,
        fontFamily: `'Press Start 2P', monospace`,
        background: PALETTE.bg,
        color: PALETTE.text,
        minHeight: `100dvh`,
        maxHeight: `100dvh`,
        padding: `8px`,
        boxSizing: `border-box`,
        overflow: `hidden`,
        touchAction: `none`,
      }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Press+Start+2P&display=swap');
        @keyframes blink { 0%,100% { opacity:1 } 50% { opacity:0.2 } }
        .live-dot { animation: blink 1.5s ease-in-out infinite; }
        .dpad-btn { transition: none; -webkit-tap-highlight-color: transparent; }
        .dpad-btn:active { background: rgba(208,188,255,0.1) !important; color: ${PALETTE.accent} !important; }
      `}</style>

      {/* Header */}
      <div
        style={{
          display: `flex`,
          alignItems: `center`,
          justifyContent: `space-between`,
          width: `100%`,
          maxWidth: W,
          marginBottom: 8,
        }}
      >
        <button
          onClick={onLeave}
          style={{
            background: `none`,
            border: `none`,
            color: PALETTE.accent,
            fontFamily: `inherit`,
            fontSize: 9,
            padding: `4px 0`,
            cursor: `pointer`,
            opacity: 0.6,
          }}
        >
          EXIT
        </button>
        <div
          style={{
            fontSize: 12,
            letterSpacing: 4,
            color: PALETTE.accent,
          }}
        >
          DURABLE SNAKE
        </div>
        <div style={{ fontSize: 8, color: PALETTE.dim }}>{connectedCount}P</div>
      </div>

      {/* Score bar */}
      <div
        style={{
          display: `flex`,
          justifyContent: `space-between`,
          alignItems: `baseline`,
          width: `100%`,
          maxWidth: W,
          marginBottom: 8,
        }}
      >
        <div>
          <div style={{ fontSize: 7, color: PALETTE.dim, marginBottom: 4 }}>
            {playerName}
          </div>
          <div style={{ display: `flex`, alignItems: `baseline`, gap: 6 }}>
            <span style={{ fontSize: 16, color: PALETTE.accent }}>
              {localScore}
            </span>
            <span style={{ fontSize: 8, color: PALETTE.dim }}>SCORE</span>
          </div>
        </div>
        {otherPlayers.size > 0 && (
          <div style={{ display: `flex`, gap: 10, fontSize: 8 }}>
            {Array.from(otherPlayers.values()).map((p, i) => (
              <span
                key={i}
                style={{ display: `flex`, alignItems: `center`, gap: 4 }}
              >
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: `50%`,
                    background: p.color,
                    display: `inline-block`,
                  }}
                />
                <span style={{ color: PALETTE.dim }}>{p.name}</span>
                <span style={{ color: PALETTE.accent }}>{p.score}</span>
              </span>
            ))}
          </div>
        )}
        {topScore && (
          <div style={{ textAlign: `right` }}>
            <div
              style={{
                display: `flex`,
                alignItems: `center`,
                justifyContent: `flex-end`,
                gap: 4,
                marginBottom: 4,
              }}
            >
              <span style={{ fontSize: 7, color: PALETTE.dim }}>
                {topScore.playerName}
              </span>
              {topScore.live && (
                <span
                  className="live-dot"
                  style={{
                    width: 5,
                    height: 5,
                    borderRadius: `50%`,
                    background: PALETTE.accent,
                    display: `inline-block`,
                  }}
                />
              )}
            </div>
            <div
              style={{
                display: `flex`,
                alignItems: `baseline`,
                justifyContent: `flex-end`,
                gap: 6,
              }}
            >
              <span style={{ fontSize: 8, color: PALETTE.dim }}>
                HIGH SCORE
              </span>
              <span style={{ fontSize: 14, color: PALETTE.accent }}>
                {topScore.score}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Game board */}
      <svg
        viewBox={`0 0 ${W} ${H}`}
        style={{
          width: `100%`,
          maxWidth: W,
          height: `auto`,
          background: PALETTE.grid,
          border: `1px solid ${PALETTE.gridLine}`,
          flex: `1 1 auto`,
          minHeight: 0,
          maxHeight: `calc(100dvh - 200px)`,
          objectFit: `contain`,
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
        <rect
          x={sharedState.food.x * CELL + 1}
          y={sharedState.food.y * CELL + 1}
          width={CELL - 2}
          height={CELL - 2}
          fill={PALETTE.food}
          stroke={PALETTE.food}
          strokeWidth={1.5}
        />

        {/* Obstacles */}
        {(() => {
          const obsSet = new Set(
            sharedState.obstacles
              .filter((o) => o.age >= 3)
              .map((o) => `${o.x},${o.y}`)
          )
          return sharedState.obstacles.map((o, i) => {
            const isAppearing = o.age < 3
            const isFading = o.age >= 180
            const opacity = isAppearing
              ? o.age / 3
              : isFading
                ? 1 - (o.age - 180) / 20
                : 1
            const x = o.x * CELL
            const y = o.y * CELL
            const color = PALETTE.obsSolid
            // Appearing obstacles render as standalone rects
            if (isAppearing) {
              return (
                <rect
                  key={`obs-${i}`}
                  x={x + 1}
                  y={y + 1}
                  width={CELL - 2}
                  height={CELL - 2}
                  fill="none"
                  stroke={color}
                  strokeWidth={1.5}
                  opacity={opacity}
                />
              )
            }
            // Solid/fading obstacles merge like snakes
            return (
              <g key={`obs-${i}`} opacity={opacity}>
                {!obsSet.has(`${o.x},${o.y - 1}`) && (
                  <line
                    x1={x}
                    y1={y}
                    x2={x + CELL}
                    y2={y}
                    stroke={color}
                    strokeWidth={1.5}
                  />
                )}
                {!obsSet.has(`${o.x},${o.y + 1}`) && (
                  <line
                    x1={x}
                    y1={y + CELL}
                    x2={x + CELL}
                    y2={y + CELL}
                    stroke={color}
                    strokeWidth={1.5}
                  />
                )}
                {!obsSet.has(`${o.x - 1},${o.y}`) && (
                  <line
                    x1={x}
                    y1={y}
                    x2={x}
                    y2={y + CELL}
                    stroke={color}
                    strokeWidth={1.5}
                  />
                )}
                {!obsSet.has(`${o.x + 1},${o.y}`) && (
                  <line
                    x1={x + CELL}
                    y1={y}
                    x2={x + CELL}
                    y2={y + CELL}
                    stroke={color}
                    strokeWidth={1.5}
                  />
                )}
              </g>
            )
          })
        })()}

        {/* Other players' snakes */}
        {Array.from(otherPlayers.entries()).map(([id, p]) => {
          const set = new Set(p.snake.map((s) => `${s.x},${s.y}`))
          return (
            <g key={`player-${id}`} opacity={0.4}>
              {p.snake.map((seg, i) => {
                const x = seg.x * CELL
                const y = seg.y * CELL
                return (
                  <g key={`${id}-seg-${i}`}>
                    {!set.has(`${seg.x},${seg.y - 1}`) && (
                      <line
                        x1={x}
                        y1={y}
                        x2={x + CELL}
                        y2={y}
                        stroke={p.color}
                        strokeWidth={1}
                      />
                    )}
                    {!set.has(`${seg.x},${seg.y + 1}`) && (
                      <line
                        x1={x}
                        y1={y + CELL}
                        x2={x + CELL}
                        y2={y + CELL}
                        stroke={p.color}
                        strokeWidth={1}
                      />
                    )}
                    {!set.has(`${seg.x - 1},${seg.y}`) && (
                      <line
                        x1={x}
                        y1={y}
                        x2={x}
                        y2={y + CELL}
                        stroke={p.color}
                        strokeWidth={1}
                      />
                    )}
                    {!set.has(`${seg.x + 1},${seg.y}`) && (
                      <line
                        x1={x}
                        y1={y}
                        x2={x + CELL}
                        y2={y + CELL}
                        stroke={p.color}
                        strokeWidth={1}
                      />
                    )}
                  </g>
                )
              })}
              {p.snake.length > 0 && (
                <text
                  x={p.snake[0].x * CELL + CELL / 2}
                  y={p.snake[0].y * CELL - 5}
                  textAnchor="middle"
                  fontSize={7}
                  fill={p.color}
                  opacity={0.7}
                  fontFamily="'Press Start 2P', monospace"
                >
                  {p.name}
                </text>
              )}
            </g>
          )
        })}

        {/* Local snake */}
        {(() => {
          const set = new Set(localSnake.map((s) => `${s.x},${s.y}`))
          return localSnake.map((seg, i) => {
            const x = seg.x * CELL
            const y = seg.y * CELL
            const sw = 1.5
            return (
              <g key={`seg-${i}`}>
                {!set.has(`${seg.x},${seg.y - 1}`) && (
                  <line
                    x1={x}
                    y1={y}
                    x2={x + CELL}
                    y2={y}
                    stroke={playerColor}
                    strokeWidth={sw}
                  />
                )}
                {!set.has(`${seg.x},${seg.y + 1}`) && (
                  <line
                    x1={x}
                    y1={y + CELL}
                    x2={x + CELL}
                    y2={y + CELL}
                    stroke={playerColor}
                    strokeWidth={sw}
                  />
                )}
                {!set.has(`${seg.x - 1},${seg.y}`) && (
                  <line
                    x1={x}
                    y1={y}
                    x2={x}
                    y2={y + CELL}
                    stroke={playerColor}
                    strokeWidth={sw}
                  />
                )}
                {!set.has(`${seg.x + 1},${seg.y}`) && (
                  <line
                    x1={x + CELL}
                    y1={y}
                    x2={x + CELL}
                    y2={y + CELL}
                    stroke={playerColor}
                    strokeWidth={sw}
                  />
                )}
              </g>
            )
          })
        })()}
      </svg>

      {/* Circular D-pad */}
      <div
        style={{
          position: `relative`,
          width: 140,
          height: 140,
          marginTop: 8,
          flexShrink: 0,
          userSelect: `none`,
          WebkitUserSelect: `none`,
        }}
      >
        {/* Outer ring */}
        <div
          style={{
            position: `absolute`,
            inset: 0,
            borderRadius: `50%`,
            border: `1px solid rgba(208,188,255,0.15)`,
          }}
        />
        {/* Up */}
        <button
          className="dpad-btn"
          style={{
            ...dpadCircleBtn,
            top: 6,
            left: `50%`,
            transform: `translateX(-50%)`,
          }}
          onTouchStart={(e) => {
            e.preventDefault()
            handleDirection(0, -1)
          }}
          onMouseDown={() => handleDirection(0, -1)}
        >
          &#9650;
        </button>
        {/* Down */}
        <button
          className="dpad-btn"
          style={{
            ...dpadCircleBtn,
            bottom: 6,
            left: `50%`,
            transform: `translateX(-50%)`,
          }}
          onTouchStart={(e) => {
            e.preventDefault()
            handleDirection(0, 1)
          }}
          onMouseDown={() => handleDirection(0, 1)}
        >
          &#9660;
        </button>
        {/* Left */}
        <button
          className="dpad-btn"
          style={{
            ...dpadCircleBtn,
            left: 6,
            top: `50%`,
            transform: `translateY(-50%)`,
          }}
          onTouchStart={(e) => {
            e.preventDefault()
            handleDirection(-1, 0)
          }}
          onMouseDown={() => handleDirection(-1, 0)}
        >
          &#9664;
        </button>
        {/* Right */}
        <button
          className="dpad-btn"
          style={{
            ...dpadCircleBtn,
            right: 6,
            top: `50%`,
            transform: `translateY(-50%)`,
          }}
          onTouchStart={(e) => {
            e.preventDefault()
            handleDirection(1, 0)
          }}
          onMouseDown={() => handleDirection(1, 0)}
        >
          &#9654;
        </button>
      </div>
    </div>
  )
}

const dpadCircleBtn: React.CSSProperties = {
  position: `absolute`,
  width: 44,
  height: 44,
  borderRadius: `50%`,
  background: `transparent`,
  border: `1px solid rgba(208,188,255,0.2)`,
  color: `rgba(208,188,255,0.35)`,
  fontSize: 14,
  fontFamily: `inherit`,
  cursor: `pointer`,
  display: `flex`,
  alignItems: `center`,
  justifyContent: `center`,
  touchAction: `manipulation`,
  padding: 0,
}
