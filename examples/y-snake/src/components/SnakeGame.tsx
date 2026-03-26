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
const FOOD_LIFESPAN = 150
const FOOD_FADE_IN = 3
const FOOD_FADE_OUT = 20

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

interface Aged extends Point {
  age: number
}

type Obstacle = Aged
type FoodItem = Aged

interface PlayerState {
  snake: Array<Point>
  dir: { dx: number; dy: number }
  score: number
  name: string
  color: string
  alive: boolean
}

interface SharedGameState {
  foods: Array<FoodItem>
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
  foods: Array<FoodItem>
): Set<string> {
  const set = new Set<string>()
  localSnake.forEach((s) => set.add(`${s.x},${s.y}`))
  otherPlayers.forEach((p) => {
    p.snake.forEach((s) => set.add(`${s.x},${s.y}`))
  })
  obstacles.forEach((o) => set.add(`${o.x},${o.y}`))
  foods.forEach((f) => set.add(`${f.x},${f.y}`))
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
  // Support legacy single-food format
  const rawFoods = gameMap.get(`foods`) as Array<FoodItem> | undefined
  const legacyFood = gameMap.get(`food`) as Point | undefined
  const foods = rawFoods
    ? rawFoods
    : legacyFood
      ? [{ ...legacyFood, age: FOOD_FADE_IN }]
      : [{ x: Math.floor(cols / 2), y: 3, age: FOOD_FADE_IN }]
  const obstacles =
    (gameMap.get(`obstacles`) as Array<Obstacle> | undefined) || []
  const tick = (gameMap.get(`tick`) as number) || 0
  return { foods, obstacles, tick, cols, rows }
}

function writeSharedGame(doc: Y.Doc, state: Partial<SharedGameState>) {
  const gameMap = doc.getMap(`game`)
  doc.transact(() => {
    if (state.foods !== undefined) gameMap.set(`foods`, state.foods)
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
    foods: [{ x: Math.floor(cols / 2), y: 3, age: FOOD_FADE_IN }],
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
  const [showPlayers, setShowPlayers] = useState(false)
  const displayRoomName = roomId.replace(/__\d+x\d+(?:_\d+ms)?$/, ``)

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
    if (!gameMap.has(`foods`) && !gameMap.has(`food`)) {
      writeSharedGame(doc, {
        foods: [{ x: rand(0, cols - 1), y: rand(0, rows - 1), age: 0 }],
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

  // Touch handler — swipe relative to snake head
  const svgRef = useRef<SVGSVGElement>(null)
  const handleTouch = useCallback(
    (e: React.TouchEvent) => {
      e.preventDefault()
      if (!svgRef.current || localSnake.length === 0) return
      const touch = e.touches[0]
      const rect = svgRef.current.getBoundingClientRect()
      // Map touch position to game grid coordinates
      const touchX = ((touch.clientX - rect.left) / rect.width) * cols
      const touchY = ((touch.clientY - rect.top) / rect.height) * rows
      const head = localSnake[0]
      const dx = touchX - (head.x + 0.5)
      const dy = touchY - (head.y + 0.5)
      // Choose the axis with the larger delta
      if (Math.abs(dx) > Math.abs(dy)) {
        dirQueue.current.push({ dx: dx > 0 ? 1 : -1, dy: 0 })
      } else {
        dirQueue.current.push({ dx: 0, dy: dy > 0 ? 1 : -1 })
      }
    },
    [localSnake, cols, rows]
  )

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

      // Check food collision — eat any food at the new head position
      let currentFoods = sharedGame.foods.map((f) => ({ ...f }))
      let foodsChanged = false
      const eatenIdx = currentFoods.findIndex(
        (f) => f.x === nx && f.y === ny && f.age >= FOOD_FADE_IN
      )
      if (eatenIdx >= 0) {
        score += POINTS_FOOD
        currentFoods.splice(eatenIdx, 1)
        foodsChanged = true
      } else {
        snake.pop()
      }

      const allPlayerIds = [playerId]
      others.forEach((_, id) => allPlayerIds.push(id))
      allPlayerIds.sort()
      const isObstacleManager = allPlayerIds[0] === playerId

      let obstaclesChanged = false

      if (isObstacleManager) {
        // Age obstacles
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
            currentFoods
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

        // Age foods and remove expired
        currentFoods = currentFoods.map((f) => ({ ...f, age: f.age + 1 }))
        currentFoods = currentFoods.filter((f) => f.age < FOOD_LIFESPAN)
        foodsChanged = true

        // Spawn new food if below max (max = ceil(playerCount / 2), min 1)
        const playerCount = allPlayerIds.length
        const maxFoods = Math.max(1, Math.ceil(playerCount / 2))
        if (currentFoods.length < maxFoods) {
          const occupied = buildOccupied(
            snake,
            others,
            currentObstacles,
            currentFoods
          )
          const newFoodPos = spawnFood(cols, rows, occupied)
          currentFoods.push({ ...newFoodPos, age: 0 })
        }
      }

      if (obstaclesChanged || foodsChanged) {
        const update: Partial<SharedGameState> = {}
        if (obstaclesChanged) update.obstacles = currentObstacles
        if (foodsChanged) update.foods = currentFoods
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

  const copyRoom = () => {
    navigator.clipboard.writeText(displayRoomName).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }

  const s = { font: 8, score: 14 } as const

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
        padding: 8,
        boxSizing: `border-box`,
        overflow: `hidden`,
        touchAction: `none`,
      }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Press+Start+2P&display=swap');
        @keyframes blink { 0%,100% { opacity:1 } 50% { opacity:0.2 } }
        .live-dot { animation: blink 1.5s ease-in-out infinite; }
      `}</style>

      {/* Header: EXIT | name@room | PLAYERS */}
      <div
        style={{
          display: `flex`,
          alignItems: `center`,
          justifyContent: `space-between`,
          width: `100%`,
          maxWidth: W,
          marginBottom: 8,
          fontSize: s.font,
        }}
      >
        <button
          onClick={onLeave}
          style={{
            background: `none`,
            border: `none`,
            color: PALETTE.accent,
            fontFamily: `inherit`,
            fontSize: s.font,
            padding: `4px 0`,
            cursor: `pointer`,
          }}
        >
          EXIT
        </button>
        <div
          style={{ display: `flex`, gap: 6, cursor: `pointer` }}
          onClick={copyRoom}
          title="Click to copy room name"
        >
          <span style={{ color: PALETTE.accent }}>{playerName}</span>
          <span style={{ color: PALETTE.dim }}>@</span>
          <span
            style={{
              color: copied ? PALETTE.accent : PALETTE.text,
              textDecoration: `underline`,
              textUnderlineOffset: 3,
            }}
          >
            {copied ? `COPIED` : displayRoomName}
          </span>
        </div>
        <div
          style={{
            color: PALETTE.accent,
            position: `relative`,
            cursor: `pointer`,
          }}
          onMouseEnter={() => setShowPlayers(true)}
          onMouseLeave={() => setShowPlayers(false)}
          onClick={() => setShowPlayers((v) => !v)}
        >
          {connectedCount} PLAYERS
          {showPlayers && otherPlayers.size > 0 && (
            <div
              style={{
                position: `absolute`,
                top: `100%`,
                right: 0,
                marginTop: 6,
                background: PALETTE.bg,
                border: `1px solid ${PALETTE.gridLine}`,
                padding: 10,
                zIndex: 5,
                minWidth: 120,
              }}
            >
              {Array.from(otherPlayers.values()).map((p, i) => (
                <div
                  key={i}
                  style={{
                    display: `flex`,
                    justifyContent: `space-between`,
                    gap: 8,
                    padding: `3px 0`,
                  }}
                >
                  <span
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
                    {p.name}
                  </span>
                  <span style={{ color: PALETTE.accent }}>{p.score}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* High score player name (right-aligned, above score row) */}
      {topScore && (
        <div
          style={{
            display: `flex`,
            justifyContent: `flex-end`,
            alignItems: `center`,
            gap: 4,
            width: `100%`,
            maxWidth: W,
            marginBottom: 6,
            fontSize: s.font,
          }}
        >
          <span style={{ color: PALETTE.dim }}>{topScore.playerName}</span>
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
      )}

      {/* Score row: both numbers on one baseline */}
      <div
        style={{
          display: `flex`,
          justifyContent: `space-between`,
          alignItems: `baseline`,
          width: `100%`,
          maxWidth: W,
          marginBottom: 8,
          fontSize: s.font,
        }}
      >
        <span>
          <span style={{ fontSize: s.score, color: PALETTE.accent }}>
            {localScore}
          </span>
          {` `}
          <span style={{ color: PALETTE.dim }}>SCORE</span>
        </span>
        {topScore && (
          <span>
            <span style={{ color: PALETTE.dim }}>HIGH SCORE</span>
            {` `}
            <span style={{ fontSize: s.score, color: PALETTE.accent }}>
              {topScore.score}
            </span>
          </span>
        )}
      </div>

      {/* Game board */}
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        onTouchStart={handleTouch}
        style={{
          width: `100%`,
          maxWidth: W,
          height: `auto`,
          background: PALETTE.grid,
          border: `1px solid ${PALETTE.gridLine}`,
          flex: `1 1 auto`,
          minHeight: 0,
          maxHeight: `calc(100dvh - 80px)`,
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
        {sharedState.foods.map((f, i) => (
          <rect
            key={`food-${i}`}
            x={f.x * CELL + 1}
            y={f.y * CELL + 1}
            width={CELL - 2}
            height={CELL - 2}
            fill={PALETTE.food}
            stroke={PALETTE.food}
            strokeWidth={1.5}
            opacity={fadeOpacity(
              f.age,
              FOOD_FADE_IN,
              FOOD_LIFESPAN,
              FOOD_FADE_OUT
            )}
          />
        ))}

        {/* Obstacles */}
        {renderMergedBlocks(
          sharedState.obstacles.filter((o) => o.age >= 3),
          PALETTE.obsSolid,
          1.5,
          (o) => fadeOpacity(o.age, 3, 200, 20)
        )}
        {sharedState.obstacles
          .filter((o) => o.age < 3)
          .map((o, i) => (
            <rect
              key={`obs-new-${i}`}
              x={o.x * CELL + 1}
              y={o.y * CELL + 1}
              width={CELL - 2}
              height={CELL - 2}
              fill="none"
              stroke={PALETTE.obsSolid}
              strokeWidth={1.5}
              opacity={o.age / 3}
            />
          ))}

        {/* Other players */}
        {Array.from(otherPlayers.entries()).map(([id, p]) => (
          <g key={id} opacity={0.5}>
            {renderMergedBlocks(p.snake, p.color, 1.5)}
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
        ))}

        {/* Local snake */}
        {renderMergedBlocks(localSnake, playerColor, 1.5)}
      </svg>
    </div>
  )
}

// ============================================================================
// Shared SVG helpers
// ============================================================================

function fadeOpacity(
  age: number,
  fadeIn: number,
  lifespan: number,
  fadeOut: number
): number {
  if (age < fadeIn) return age / fadeIn
  if (age >= lifespan - fadeOut)
    return Math.max(0, 1 - (age - (lifespan - fadeOut)) / fadeOut)
  return 1
}

function renderMergedBlocks(
  points: Array<{ x: number; y: number; age?: number }>,
  color: string,
  sw: number,
  opacityFn?: (p: { x: number; y: number; age?: number }) => number
) {
  const set = new Set(points.map((p) => `${p.x},${p.y}`))
  return points.map((p, i) => {
    const x = p.x * CELL
    const y = p.y * CELL
    const opacity = opacityFn ? opacityFn(p) : undefined
    return (
      <g key={i} opacity={opacity}>
        {!set.has(`${p.x},${p.y - 1}`) && (
          <line
            x1={x}
            y1={y}
            x2={x + CELL}
            y2={y}
            stroke={color}
            strokeWidth={sw}
          />
        )}
        {!set.has(`${p.x},${p.y + 1}`) && (
          <line
            x1={x}
            y1={y + CELL}
            x2={x + CELL}
            y2={y + CELL}
            stroke={color}
            strokeWidth={sw}
          />
        )}
        {!set.has(`${p.x - 1},${p.y}`) && (
          <line
            x1={x}
            y1={y}
            x2={x}
            y2={y + CELL}
            stroke={color}
            strokeWidth={sw}
          />
        )}
        {!set.has(`${p.x + 1},${p.y}`) && (
          <line
            x1={x + CELL}
            y1={y}
            x2={x + CELL}
            y2={y + CELL}
            stroke={color}
            strokeWidth={sw}
          />
        )}
      </g>
    )
  })
}
