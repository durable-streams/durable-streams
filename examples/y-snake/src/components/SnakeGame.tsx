import { useCallback, useEffect, useMemo, useRef, useState } from "react"
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
const FOOD_TTL_MS = 25_000
const FOOD_FADE_IN_MS = 600
const FOOD_FADE_OUT_MS = 4_000
const FOOD_EATEN_LINGER_MS = 300
const OBSTACLE_LIFESPAN = 200
const OBSTACLE_FADE_OUT = 20

const FONT_SM = 8
const FONT_SCORE = 14

const PALETTE = {
  bg: `#1b1b1f`,
  grid: `#202127`,
  gridLine: `#2e2e32`,
  border: `#2e2e32`,
  snake: `#75fbfd`,
  food: `#00d2a0`,
  obsSolid: `#d0bcff`,
  text: `rgba(235,235,245,0.68)`,
  accent: `#d0bcff`,
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

interface FoodCell {
  spawnedAt: number
  eatenBy?: string
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
  foodKeys: Set<string>
): Set<string> {
  const set = new Set<string>()
  localSnake.forEach((s) => set.add(`${s.x},${s.y}`))
  otherPlayers.forEach((p) => {
    p.snake.forEach((s) => set.add(`${s.x},${s.y}`))
  })
  obstacles.forEach((o) => set.add(`${o.x},${o.y}`))
  foodKeys.forEach((k) => set.add(k))
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
  const obstacles =
    (gameMap.get(`obstacles`) as Array<Obstacle> | undefined) || []
  const tick = (gameMap.get(`tick`) as number) || 0
  return { obstacles, tick, cols, rows }
}

function writeSharedGame(doc: Y.Doc, state: Partial<SharedGameState>) {
  const gameMap = doc.getMap(`game`)
  doc.transact(() => {
    if (state.obstacles !== undefined) gameMap.set(`obstacles`, state.obstacles)
    if (state.tick !== undefined) gameMap.set(`tick`, state.tick)
  })
}

// ============================================================================
// Food cell helpers (Y.Map CRDT)
// ============================================================================

function getFoodMap(doc: Y.Doc) {
  return doc.getMap(`foodCells`)
}

function readFoodCells(doc: Y.Doc): Map<string, FoodCell> {
  const result = new Map<string, FoodCell>()
  const foodMap = getFoodMap(doc)
  const now = Date.now()
  foodMap.forEach((val, key) => {
    const cell = val
    // Skip fully expired cells
    if (now - cell.spawnedAt > FOOD_TTL_MS) return
    // Skip eaten cells that have lingered
    if (cell.eatenBy && now - cell.spawnedAt > FOOD_TTL_MS) return
    result.set(key, cell)
  })
  return result
}

function tryEatFood(doc: Y.Doc, key: string, eatenBy: string): boolean {
  const foodMap = getFoodMap(doc)
  const cell = foodMap.get(key)
  if (!cell || cell.eatenBy) return false
  doc.transact(() => {
    foodMap.set(key, { ...cell, eatenBy })
  })
  return true
}

function cleanupFoodCells(doc: Y.Doc) {
  const foodMap = getFoodMap(doc)
  const now = Date.now()
  const toDelete: Array<string> = []
  foodMap.forEach((val, key) => {
    const cell = val
    if (now - cell.spawnedAt > FOOD_TTL_MS) {
      toDelete.push(key)
    } else if (
      cell.eatenBy &&
      now - cell.spawnedAt > cell.spawnedAt + FOOD_EATEN_LINGER_MS
    ) {
      // eatenBy set and lingered enough — clean up
      toDelete.push(key)
    }
  })
  if (toDelete.length > 0) {
    doc.transact(() => {
      toDelete.forEach((k) => foodMap.delete(k))
    })
  }
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
  const { cols, rows, baseTick } = useMemo(
    () => parseRoomConfig(roomId),
    [roomId]
  )

  const [localSnake, setLocalSnake] = useState<Array<Point>>([])
  const [localScore, setLocalScore] = useState(0)
  const [sharedState, setSharedState] = useState<SharedGameState>({
    obstacles: [],
    tick: 0,
    cols,
    rows,
  })
  const [foodCells, setFoodCells] = useState<Map<string, FoodCell>>(new Map())
  const [otherPlayers, setOtherPlayers] = useState<Map<string, PlayerState>>(
    new Map()
  )
  const [connectedCount, setConnectedCount] = useState(1)
  const [copied, setCopied] = useState(false)
  const [showPlayers, setShowPlayers] = useState(false)
  const displayRoomName = roomId.replace(/__\d+x\d+(?:_\d+ms)?$/, ``)
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)

  // High scores from StreamDB
  const { data: highScores = [] } = useLiveQuery(
    (q) => (scoresDB ? q.from({ scores: scoresDB.collections.scores }) : null),
    [scoresDB]
  )
  const mergedHighScores = useMemo(() => {
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
  }, [highScores, localScore, otherPlayers, playerName])

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

    // Spawn initial food if none exists
    const foodMap = getFoodMap(doc)
    if (foodMap.size === 0) {
      const pos = spawnFood(cols, rows, new Set())
      doc.transact(() => {
        foodMap.set(`${pos.x},${pos.y}`, { spawnedAt: Date.now() })
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

  // Observe food cells (Y.Map CRDT)
  useEffect(() => {
    const foodMap = getFoodMap(doc)
    const handler = () => setFoodCells(readFoodCells(doc))
    foodMap.observe(handler)
    handler()
    return () => foodMap.unobserve(handler)
  }, [doc])

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

  // Observe awareness for player presence — only track count to minimize re-renders
  useEffect(() => {
    const handler = () => {
      const activePlayerIds = new Set<string>()
      let otherCount = 0

      awareness.getStates().forEach((state, clientId) => {
        if (clientId !== awareness.clientID) {
          otherCount++
          if (state.playerId) activePlayerIds.add(state.playerId)
        }
      })
      setConnectedCount((prev) => {
        const next = otherCount + 1
        return prev === next ? prev : next
      })

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
    [
      doc,
      playerId,
      playerName,
      playerColor,
      baseTick,
      initSnake,
      submitScoreIfHigher,
    ]
  )

  // Keep respawn in a ref so the game loop doesn't restart when it changes
  const respawnRef = useRef(respawn)
  useEffect(() => {
    respawnRef.current = respawn
  }, [respawn])

  // Swipe gesture handler
  const svgRef = useRef<SVGSVGElement>(null)
  const touchStartRef = useRef<{ x: number; y: number } | null>(null)
  const SWIPE_THRESHOLD = 10 // min pixels to register a swipe

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    e.preventDefault()
    const t = e.touches[0]
    touchStartRef.current = { x: t.clientX, y: t.clientY }
  }, [])

  const onTouchMove = useCallback((e: React.TouchEvent) => {
    e.preventDefault()
    if (!touchStartRef.current) return
    const t = e.touches[0]
    const dx = t.clientX - touchStartRef.current.x
    const dy = t.clientY - touchStartRef.current.y
    if (Math.abs(dx) < SWIPE_THRESHOLD && Math.abs(dy) < SWIPE_THRESHOLD) return
    // Register swipe direction and reset start for continuous control
    if (Math.abs(dx) > Math.abs(dy)) {
      dirQueue.current.push({ dx: dx > 0 ? 1 : -1, dy: 0 })
    } else {
      dirQueue.current.push({ dx: 0, dy: dy > 0 ? 1 : -1 })
    }
    touchStartRef.current = { x: t.clientX, y: t.clientY }
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
        respawnRef.current(score)
        if (!isCancelled()) timeoutId = setTimeout(tick, baseTick)
        return
      }

      snake.unshift({ x: nx, y: ny })

      // Food collision — each player writes eatenBy via Y.Map LWW
      const foodKey = `${nx},${ny}`
      const foodMap = getFoodMap(doc)
      const foodAtHead = foodMap.get(foodKey)
      const now = Date.now()
      if (
        foodAtHead &&
        !foodAtHead.eatenBy &&
        now - foodAtHead.spawnedAt >= FOOD_FADE_IN_MS
      ) {
        tryEatFood(doc, foodKey, playerId)
        score += POINTS_FOOD
      } else {
        snake.pop()
      }

      // Obstacle manager handles obstacles + food spawning/cleanup
      const allPlayerIds = [playerId]
      others.forEach((_, id) => allPlayerIds.push(id))
      allPlayerIds.sort()
      const isObstacleManager = allPlayerIds[0] === playerId

      if (isObstacleManager) {
        // Age obstacles
        currentObstacles = currentObstacles.map((o) => ({
          ...o,
          age: o.age + 1,
        }))
        currentObstacles = currentObstacles.filter(
          (o) => o.age < OBSTACLE_LIFESPAN
        )

        if (obstacleTimer <= 0 && currentObstacles.length < MAX_OBSTACLES) {
          obstacleTimer = Math.max(
            10,
            OBSTACLE_INTERVAL - Math.floor(score / 80)
          )
          const foodKeys = new Set<string>()
          foodMap.forEach((_: unknown, k: string) => foodKeys.add(k))
          const occupied = buildOccupied(
            snake,
            others,
            currentObstacles,
            foodKeys
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

        writeSharedGame(doc, { obstacles: currentObstacles })

        // Cleanup expired/eaten food cells
        cleanupFoodCells(doc)

        // Spawn food — 1 per player in the room
        const activeFoodCount = Array.from(foodMap.values()).filter(
          (v) => !v.eatenBy
        ).length
        const maxFoods = Math.max(1, allPlayerIds.length)
        if (activeFoodCount < maxFoods) {
          const foodKeys = new Set<string>()
          foodMap.forEach((_: unknown, k: string) => foodKeys.add(k))
          const occupied = buildOccupied(
            snake,
            others,
            currentObstacles,
            foodKeys
          )
          const pos = spawnFood(cols, rows, occupied)
          doc.transact(() => {
            foodMap.set(`${pos.x},${pos.y}`, { spawnedAt: Date.now() })
          })
        }
      }

      const newSpeed = Math.max(60, baseTick - Math.floor(score / 20))

      Object.assign(ref, { snake, dir, score, obstacleTimer, speed: newSpeed })
      setLocalSnake([...snake])
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
  }, [doc, playerId, playerName, playerColor, cols, rows, baseTick])

  // ============================================================================
  // Render
  // ============================================================================

  const W = cols * CELL
  const H = rows * CELL
  const topScore = mergedHighScores.length > 0 ? mergedHighScores[0] : null

  const copyRoom = useCallback(() => {
    navigator.clipboard.writeText(displayRoomName).catch(() => {})
    setCopied(true)
    clearTimeout(copiedTimerRef.current)
    copiedTimerRef.current = setTimeout(() => setCopied(false), 1200)
  }, [displayRoomName])

  useEffect(() => () => clearTimeout(copiedTimerRef.current), [])

  const gridLines = useMemo(
    () => (
      <>
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
      </>
    ),
    [cols, rows, W, H]
  )

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
        @keyframes blink { 0%,100% { opacity:1 } 50% { opacity:0.3 } }
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
          fontSize: FONT_SM,
        }}
      >
        <button
          onClick={onLeave}
          style={{
            background: `none`,
            border: `none`,
            color: PALETTE.accent,
            fontFamily: `inherit`,
            fontSize: FONT_SM,
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
                border: `1px solid ${PALETTE.border}`,
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

      {/* High score holder name */}
      {topScore && (
        <div
          style={{
            display: `flex`,
            justifyContent: `flex-end`,
            alignItems: `center`,
            gap: 4,
            width: `100%`,
            maxWidth: W,
            marginBottom: 4,
            fontSize: FONT_SM,
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

      {/* Score row — single line, baseline aligned */}
      <div
        style={{
          display: `flex`,
          justifyContent: `space-between`,
          alignItems: `baseline`,
          width: `100%`,
          maxWidth: W,
          marginBottom: 8,
          fontSize: FONT_SM,
        }}
      >
        <span>
          <span style={{ fontSize: FONT_SCORE, color: PALETTE.accent }}>
            {localScore}
          </span>
          {` `}
          <span style={{ color: PALETTE.dim }}>SCORE</span>
        </span>
        {topScore && (
          <span>
            <span style={{ color: PALETTE.dim }}>HIGH SCORE</span>
            {` `}
            <span style={{ fontSize: FONT_SCORE, color: PALETTE.accent }}>
              {topScore.score}
            </span>
          </span>
        )}
      </div>

      {/* Game board */}
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        style={{
          width: `100%`,
          maxWidth: W,
          height: `auto`,
          background: PALETTE.grid,
          border: `1px solid ${PALETTE.border}`,
          flex: `1 1 auto`,
          minHeight: 0,
          maxHeight: `calc(100dvh - 120px)`,
          objectFit: `contain`,
        }}
      >
        {gridLines}

        {/* Food (Y.Map CRDT cells) */}
        {Array.from(foodCells.entries()).map(([key, cell]) => {
          const [fx, fy] = key.split(`,`).map(Number)
          const age = Date.now() - cell.spawnedAt
          const isEaten = !!cell.eatenBy
          let opacity = 1
          if (age < FOOD_FADE_IN_MS) opacity = age / FOOD_FADE_IN_MS
          else if (age > FOOD_TTL_MS - FOOD_FADE_OUT_MS)
            opacity = Math.max(
              0,
              1 - (age - (FOOD_TTL_MS - FOOD_FADE_OUT_MS)) / FOOD_FADE_OUT_MS
            )
          if (isEaten) opacity = 0.3
          return (
            <rect
              key={key}
              x={fx * CELL + 1}
              y={fy * CELL + 1}
              width={CELL - 2}
              height={CELL - 2}
              fill={PALETTE.food}
              stroke={PALETTE.food}
              strokeWidth={1.5}
              opacity={opacity}
            />
          )
        })}

        {/* Obstacles */}
        {renderMergedBlocks(
          sharedState.obstacles.filter((o) => o.age >= 3),
          PALETTE.obsSolid,
          1.5,
          (o) =>
            fadeOpacity(o.age ?? 0, 3, OBSTACLE_LIFESPAN, OBSTACLE_FADE_OUT)
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
  return points.map((p) => {
    const x = p.x * CELL
    const y = p.y * CELL
    const opacity = opacityFn ? opacityFn(p) : undefined
    return (
      <g key={`${p.x},${p.y}`} opacity={opacity}>
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
