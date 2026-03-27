import { useState, useEffect, useRef, useCallback } from "react"

const CELL = 20
const COLS = 30
const ROWS = 24
const BASE_TICK = 120
const OBSTACLE_INTERVAL = 8 // ticks between obstacle spawns
const OBS_MIN_DIST = 4
const OBS_MAX_DIST = 10
const MAX_OBSTACLES = 40

function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function dist(x1, y1, x2, y2) {
  return Math.abs(x1 - x2) + Math.abs(y1 - y2)
}

function spawnFood(snake, obstacles) {
  const occupied = new Set()
  snake.forEach((s) => occupied.add(`${s.x},${s.y}`))
  obstacles.forEach((o) => occupied.add(`${o.x},${o.y}`))
  let attempts = 0
  while (attempts < 500) {
    const x = rand(0, COLS - 1),
      y = rand(0, ROWS - 1)
    if (!occupied.has(`${x},${y}`)) return { x, y }
    attempts++
  }
  return { x: 0, y: 0 }
}

function spawnObstacle(snake, obstacles, food) {
  const head = snake[0]
  const occupied = new Set()
  snake.forEach((s) => occupied.add(`${s.x},${s.y}`))
  obstacles.forEach((o) => occupied.add(`${o.x},${o.y}`))
  occupied.add(`${food.x},${food.y}`)

  let attempts = 0
  while (attempts < 200) {
    const x = rand(0, COLS - 1),
      y = rand(0, ROWS - 1)
    const d = dist(head.x, head.y, x, y)
    if (d >= OBS_MIN_DIST && d <= OBS_MAX_DIST && !occupied.has(`${x},${y}`)) {
      return { x, y, age: 0, warned: false }
    }
    attempts++
  }
  return null
}

const DIR_MAP = {
  ArrowUp: { dx: 0, dy: -1 },
  ArrowDown: { dx: 0, dy: 1 },
  ArrowLeft: { dx: -1, dy: 0 },
  ArrowRight: { dx: 1, dy: 0 },
  w: { dx: 0, dy: -1 },
  s: { dx: 0, dy: 1 },
  a: { dx: -1, dy: 0 },
  d: { dx: 1, dy: 0 },
}

const PALETTE = {
  bg: "#0B0E17",
  grid: "#0F1322",
  gridLine: "#151A2E",
  snake: "#00E5FF",
  snakeHead: "#00FFF7",
  snakeGlow: "rgba(0,229,255,0.25)",
  food: "#FF3D71",
  foodGlow: "rgba(255,61,113,0.3)",
  obsWarn: "#FFD93D",
  obsSolid: "#FF6B35",
  obsDead: "#FF3D71",
  text: "#8892B0",
  accent: "#00E5FF",
}

export default function SnakeGame() {
  const [latency, setLatency] = useState(0)
  const [game, setGame] = useState(null)
  const [gameOver, setGameOver] = useState(false)
  const [roundTrip, setRoundTrip] = useState(null)
  const [highScore, setHighScore] = useState(0)
  const pendingDir = useRef(null)
  const dirQueue = useRef([])
  const inputTimeRef = useRef(null)
  const gameRef = useRef(null)

  const initGame = useCallback(() => {
    const startX = Math.floor(COLS / 2)
    const startY = Math.floor(ROWS / 2)
    const snake = [
      { x: startX, y: startY },
      { x: startX - 1, y: startY },
      { x: startX - 2, y: startY },
    ]
    const state = {
      snake,
      dir: { dx: 1, dy: 0 },
      food: spawnFood(snake, []),
      obstacles: [],
      score: 0,
      tick: 0,
      speed: BASE_TICK,
      obstacleTimer: OBSTACLE_INTERVAL,
    }
    setGame(state)
    setGameOver(false)
    setRoundTrip(null)
    dirQueue.current = []
    pendingDir.current = null
    gameRef.current = state
  }, [])

  useEffect(() => {
    initGame()
  }, [initGame])

  // Input handling with latency simulation
  useEffect(() => {
    const handleKey = (e) => {
      if (DIR_MAP[e.key]) {
        e.preventDefault()
        inputTimeRef.current = performance.now()
        const newDir = DIR_MAP[e.key]
        setTimeout(() => {
          dirQueue.current.push(newDir)
        }, latency)
      }
    }
    window.addEventListener("keydown", handleKey)
    return () => window.removeEventListener("keydown", handleKey)
  }, [latency])

  // Game loop
  useEffect(() => {
    if (!game || gameOver) return
    const interval = setInterval(() => {
      setGame((prev) => {
        if (!prev) return prev
        const s = {
          snake: prev.snake.map((p) => ({ ...p })),
          dir: { ...prev.dir },
          food: { ...prev.food },
          obstacles: prev.obstacles.map((o) => ({ ...o })),
          score: prev.score,
          tick: prev.tick + 1,
          speed: prev.speed,
          obstacleTimer: prev.obstacleTimer - 1,
        }

        // Process direction queue
        while (dirQueue.current.length > 0) {
          const newDir = dirQueue.current.shift()
          // Prevent 180-degree turns
          if (newDir.dx !== -s.dir.dx || newDir.dy !== -s.dir.dy) {
            // Also prevent same-direction spam
            if (newDir.dx !== s.dir.dx || newDir.dy !== s.dir.dy) {
              s.dir = newDir
              if (inputTimeRef.current) {
                const now = performance.now()
                setTimeout(
                  () =>
                    setRoundTrip(
                      Math.round(now - inputTimeRef.current + latency)
                    ),
                  latency
                )
                inputTimeRef.current = null
              }
            }
            break
          }
        }

        // Move snake
        const head = s.snake[0]
        const nx = head.x + s.dir.dx
        const ny = head.y + s.dir.dy

        // Wall collision
        if (nx < 0 || nx >= COLS || ny < 0 || ny >= ROWS) {
          setGameOver(true)
          setHighScore((h) => Math.max(h, s.score))
          return s
        }

        // Self collision
        if (s.snake.some((seg) => seg.x === nx && seg.y === ny)) {
          setGameOver(true)
          setHighScore((h) => Math.max(h, s.score))
          return s
        }

        // Obstacle collision
        if (s.obstacles.some((o) => o.x === nx && o.y === ny && o.age >= 3)) {
          setGameOver(true)
          setHighScore((h) => Math.max(h, s.score))
          return s
        }

        s.snake.unshift({ x: nx, y: ny })

        // Eat food
        if (nx === s.food.x && ny === s.food.y) {
          s.score += 10
          s.food = spawnFood(s.snake, s.obstacles)
          // Speed up slightly
          s.speed = Math.max(60, s.speed - 1)
        } else {
          s.snake.pop()
        }

        // Age obstacles (warning → solid transition)
        s.obstacles.forEach((o) => {
          o.age++
        })

        // Spawn new obstacle — delayed by latency to simulate sync
        if (s.obstacleTimer <= 0 && s.obstacles.length < MAX_OBSTACLES) {
          s.obstacleTimer = Math.max(
            4,
            OBSTACLE_INTERVAL - Math.floor(s.score / 50)
          )
          // Obstacle spawn is "from the server" so it's delayed
          const obs = spawnObstacle(s.snake, s.obstacles, s.food)
          if (obs) {
            // With latency, the obstacle appears later — less warning time
            setTimeout(() => {
              setGame((prev2) => {
                if (!prev2) return prev2
                return {
                  ...prev2,
                  obstacles: [...prev2.obstacles, obs],
                }
              })
            }, latency)
            // Don't add it now — the setTimeout above handles it
            // But at 0 latency we need it immediately
            if (latency === 0 && obs) {
              s.obstacles.push(obs)
            }
          }
        }

        // Remove very old obstacles to keep it playable
        s.obstacles = s.obstacles.filter((o) => o.age < 120)

        gameRef.current = s
        return s
      })
    }, game.speed)
    return () => clearInterval(interval)
  }, [game?.speed, gameOver, latency])

  if (!game) return null

  const W = COLS * CELL
  const H = ROWS * CELL

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        fontFamily: "'JetBrains Mono', 'SF Mono', monospace",
        background: PALETTE.bg,
        color: PALETTE.text,
        minHeight: "100vh",
        padding: "12px",
        boxSizing: "border-box",
      }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700;800&display=swap');
        @keyframes warnPulse { 0%,100% { opacity:0.3 } 50% { opacity:0.9 } }
        @keyframes foodBob { 0%,100% { transform:scale(1) } 50% { transform:scale(1.2) } }
        @keyframes spawn { from { transform:scale(0);opacity:0 } to { transform:scale(1);opacity:1 } }
        @keyframes deathFlash { 0% { opacity:1 } 50% { opacity:0.2 } 100% { opacity:1 } }
      `}</style>

      {/* Header */}
      <div
        style={{
          fontSize: 15,
          fontWeight: 800,
          letterSpacing: 4,
          marginBottom: 2,
          color: PALETTE.snakeHead,
        }}
      >
        SNAKE
      </div>
      <div style={{ fontSize: 8, color: "#444", marginBottom: 8 }}>
        Obstacles spawn near your head via sync — high latency = less warning
        time
      </div>

      {/* Controls row */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 16,
          marginBottom: 8,
          background: "#0E1225",
          padding: "6px 16px",
          borderRadius: 8,
          border: "1px solid #1A1F38",
        }}
      >
        <span style={{ fontSize: 9, color: "#555" }}>SYNC LATENCY</span>
        <input
          type="range"
          min={0}
          max={500}
          step={10}
          value={latency}
          onChange={(e) => setLatency(+e.target.value)}
          style={{
            width: 120,
            accentColor:
              latency < 100
                ? PALETTE.accent
                : latency < 250
                  ? PALETTE.obsWarn
                  : PALETTE.food,
          }}
        />
        <span
          style={{
            fontSize: 13,
            fontWeight: 700,
            minWidth: 50,
            textAlign: "right",
            color:
              latency < 100
                ? PALETTE.accent
                : latency < 250
                  ? PALETTE.obsWarn
                  : PALETTE.food,
          }}
        >
          {latency}ms
        </span>
        {roundTrip !== null && (
          <span style={{ fontSize: 8, color: "#666" }}>
            RT{" "}
            <span
              style={{
                color:
                  roundTrip < 150 ? "#0f0" : roundTrip < 350 ? "#ff0" : "#f00",
              }}
            >
              {roundTrip}ms
            </span>
          </span>
        )}
      </div>

      {/* Score bar */}
      <div
        style={{
          display: "flex",
          gap: 24,
          marginBottom: 6,
          fontSize: 10,
          fontWeight: 600,
        }}
      >
        <span>
          SCORE{" "}
          <span style={{ color: PALETTE.accent, fontSize: 13 }}>
            {game.score}
          </span>
        </span>
        <span>
          LENGTH{" "}
          <span style={{ color: PALETTE.accent }}>{game.snake.length}</span>
        </span>
        <span>
          OBSTACLES{" "}
          <span style={{ color: PALETTE.obsSolid }}>
            {game.obstacles.length}
          </span>
        </span>
        <span style={{ color: "#333" }}>
          HI <span style={{ color: "#555" }}>{highScore}</span>
        </span>
      </div>

      {/* Game board */}
      <div style={{ position: "relative" }}>
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
          {/* Subtle grid */}
          {Array.from({ length: COLS }, (_, i) => (
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
          {Array.from({ length: ROWS }, (_, i) => (
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

          {/* Food glow */}
          <circle
            cx={game.food.x * CELL + CELL / 2}
            cy={game.food.y * CELL + CELL / 2}
            r={CELL * 1.2}
            fill={PALETTE.foodGlow}
            opacity={0.4}
          />

          {/* Food */}
          <circle
            cx={game.food.x * CELL + CELL / 2}
            cy={game.food.y * CELL + CELL / 2}
            r={CELL / 2 - 2}
            fill={PALETTE.food}
          />
          <circle
            cx={game.food.x * CELL + CELL / 2 - 2}
            cy={game.food.y * CELL + CELL / 2 - 2}
            r={2}
            fill="rgba(255,255,255,0.4)"
          />

          {/* Obstacles */}
          {game.obstacles.map((o, i) => {
            const isWarning = o.age < 3
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
                    style={{ animation: "warnPulse 0.4s ease-in-out infinite" }}
                  />
                  <text
                    x={cx}
                    y={cy + 4}
                    textAnchor="middle"
                    fontSize={12}
                    fill={PALETTE.obsWarn}
                    fontWeight={800}
                    style={{ animation: "warnPulse 0.4s ease-in-out infinite" }}
                  >
                    !
                  </text>
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
                <rect
                  x={o.x * CELL + 3}
                  y={o.y * CELL + 3}
                  width={CELL - 6}
                  height={CELL / 2 - 2}
                  fill="rgba(255,255,255,0.12)"
                  rx={2}
                />
                {/* X mark */}
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

          {/* Snake glow trail */}
          <circle
            cx={game.snake[0].x * CELL + CELL / 2}
            cy={game.snake[0].y * CELL + CELL / 2}
            r={CELL * 1.5}
            fill={PALETTE.snakeGlow}
          />

          {/* Snake body */}
          {game.snake.map((seg, i) => {
            const isHead = i === 0
            const isTail = i === game.snake.length - 1
            const progress = i / game.snake.length
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
                  fill={isHead ? PALETTE.snakeHead : PALETTE.snake}
                  opacity={alpha}
                />
                {isHead && (
                  <>
                    {/* Eyes */}
                    {(() => {
                      const dir = game.dir
                      const cx = seg.x * CELL + CELL / 2
                      const cy = seg.y * CELL + CELL / 2
                      const ex1 = cx + dir.dy * 4 + dir.dx * 3
                      const ey1 = cy - dir.dx * 4 + dir.dy * 3
                      const ex2 = cx - dir.dy * 4 + dir.dx * 3
                      const ey2 = cy + dir.dx * 4 + dir.dy * 3
                      return (
                        <>
                          <circle cx={ex1} cy={ey1} r={2.5} fill="#FFF" />
                          <circle cx={ex2} cy={ey2} r={2.5} fill="#FFF" />
                          <circle
                            cx={ex1 + dir.dx * 0.8}
                            cy={ey1 + dir.dy * 0.8}
                            r={1.3}
                            fill="#111"
                          />
                          <circle
                            cx={ex2 + dir.dx * 0.8}
                            cy={ey2 + dir.dy * 0.8}
                            r={1.3}
                            fill="#111"
                          />
                        </>
                      )
                    })()}
                  </>
                )}
              </g>
            )
          })}

          {/* Danger zone indicator — shows where obstacles can spawn */}
          {!gameOver && (
            <circle
              cx={game.snake[0].x * CELL + CELL / 2}
              cy={game.snake[0].y * CELL + CELL / 2}
              r={OBS_MAX_DIST * CELL}
              fill="none"
              stroke="rgba(255,107,53,0.06)"
              strokeWidth={1}
              strokeDasharray="4 6"
            />
          )}
        </svg>

        {/* Death overlay */}
        {gameOver && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              background: "rgba(11,14,23,0.92)",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 10,
              borderRadius: 6,
            }}
          >
            <div style={{ fontSize: 9, color: "#555", letterSpacing: 3 }}>
              GAME OVER
            </div>
            <div style={{ fontSize: 28, fontWeight: 800, color: PALETTE.food }}>
              {game.score}
            </div>
            <div style={{ fontSize: 9, color: "#555" }}>
              {game.snake.length} length • {game.obstacles.length} obstacles •{" "}
              {latency}ms latency
            </div>
            {latency > 100 && (
              <div
                style={{
                  fontSize: 9,
                  color: PALETTE.obsWarn,
                  maxWidth: 280,
                  textAlign: "center",
                  lineHeight: 1.5,
                }}
              >
                At {latency}ms sync latency, obstacles appeared with{" "}
                {Math.round((latency / game.speed) * 100) / 100} fewer ticks of
                warning time
              </div>
            )}
            <button
              onClick={initGame}
              style={{
                fontFamily: "inherit",
                fontSize: 10,
                padding: "8px 28px",
                background: PALETTE.accent,
                color: "#000",
                border: "none",
                cursor: "pointer",
                borderRadius: 4,
                fontWeight: 700,
                marginTop: 4,
              }}
            >
              PLAY AGAIN
            </button>
          </div>
        )}
      </div>

      {/* Explainer */}
      <div
        style={{
          fontSize: 8,
          color: "#333",
          marginTop: 8,
          textAlign: "center",
          maxWidth: 420,
          lineHeight: 1.6,
        }}
      >
        Obstacles are spawned by a "server peer" and synced via the shared doc.
        At 0ms latency you see the ⚠ warning in time. At 300ms+ the obstacle
        appears solid with almost no warning — you're reacting to stale state.
      </div>
    </div>
  )
}
