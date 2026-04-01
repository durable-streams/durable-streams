import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  GAME_DURATION_MS,
  MOVE_INTERVAL,
  PLAYER_COLORS,
  WIN_THRESHOLD,
  countCellsForPlayer,
  executeMove,
  findLeaderByScore,
  findWinner,
  getCellsMap,
  getGameEndedAt,
  getGameStartedAt,
  getPlayerScores,
  getPlayersMap,
  initGameTimer,
  parseRoomConfig,
  readCells,
  readPlayers,
  setGameEnded,
} from "../utils/game-logic"
import { useGameRoom } from "./game-room-context"
import type { TerritoryCell, TerritoryPlayer } from "../utils/game-logic"

// ============================================================================
// Constants
// ============================================================================

const POINTS_PER_CELL = 1

const FONT_SM = 8
const FONT_SCORE = 14

const PALETTE = {
  bg: `#1b1b1f`,
  grid: `#202127`,
  gridLine: `#2e2e32`,
  border: `#2e2e32`,
  text: `rgba(235,235,245,0.68)`,
  accent: `#d0bcff`,
  dim: `rgba(235,235,245,0.38)`,
}

// ============================================================================
// Helpers
// ============================================================================

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

function computeCellSize(cols: number, rows: number): number {
  if (cols > 256 || rows > 256) return 2
  if (cols > 64 || rows > 64) return 4
  return 14
}

// ============================================================================
// TerritoryGame component
// ============================================================================

interface TerritoryGameProps {
  onLeave: () => void
}

export function TerritoryGame({ onLeave }: TerritoryGameProps) {
  const { doc, awareness, roomId, playerId, playerName, playerColor } =
    useGameRoom()
  const { cols, rows } = useMemo(() => parseRoomConfig(roomId), [roomId])
  const totalCells = cols * rows
  const CELL = useMemo(() => computeCellSize(cols, rows), [cols, rows])
  const showGridLines = cols <= 100 && rows <= 100

  const [cells, setCells] = useState<Map<string, TerritoryCell>>(new Map())
  const [otherPlayers, setOtherPlayers] = useState<
    Map<string, TerritoryPlayer>
  >(new Map())
  const [localPos, setLocalPos] = useState<{ x: number; y: number }>({
    x: 0,
    y: 0,
  })
  const [connectedCount, setConnectedCount] = useState(1)
  const [copied, setCopied] = useState(false)
  const [showPlayers, setShowPlayers] = useState(false)
  const [winner, setWinner] = useState<{ name: string; pct: number } | null>(
    null
  )
  const [timeRemaining, setTimeRemaining] = useState(GAME_DURATION_MS / 1000)
  const displayRoomName = roomId.replace(/__\d+x\d+(?:_\d+ms)?$/, ``)
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)

  // Refs for the movement loop
  const dirRef = useRef<{ dx: number; dy: number } | null>(null)
  const localRef = useRef({
    x: 0,
    y: 0,
    stunnedUntil: 0,
  })

  const myScore = useMemo(
    () => countCellsForPlayer(cells, playerId) * POINTS_PER_CELL,
    [cells, playerId]
  )

  const myPercentage = useMemo(
    () => Math.round((myScore / totalCells) * 100),
    [myScore, totalCells]
  )

  const playerScores = useMemo(() => getPlayerScores(cells), [cells])

  const leader = useMemo(() => {
    let maxCells = 0
    let leaderId = ``
    playerScores.forEach((count, id) => {
      if (count > maxCells) {
        maxCells = count
        leaderId = id
      }
    })
    if (!leaderId || maxCells === 0) return null
    const leaderPct = Math.round((maxCells / totalCells) * 100)
    if (leaderId === playerId) return { name: playerName, pct: leaderPct }
    const other = otherPlayers.get(leaderId)
    return other ? { name: other.name, pct: leaderPct } : null
  }, [playerScores, totalCells, playerId, playerName, otherPlayers])

  // Initialize player position and game timer
  useEffect(() => {
    const startX = Math.floor(Math.random() * cols)
    const startY = Math.floor(Math.random() * rows)
    localRef.current = { x: startX, y: startY, stunnedUntil: 0 }
    setLocalPos({ x: startX, y: startY })

    const playersMap = getPlayersMap(doc)
    playersMap.set(playerId, {
      x: startX,
      y: startY,
      name: playerName,
    })

    const cellsMap = getCellsMap(doc)
    doc.transact(() => {
      cellsMap.set(`${startX},${startY}`, {
        owner: playerId,
        claimedAt: Date.now(),
      })
    })

    // Start the game timer if not already started
    initGameTimer(doc)

    return () => {
      playersMap.delete(playerId)
    }
  }, [doc, playerId, playerName, playerColor, cols, rows])

  // Observe cells + check win condition
  useEffect(() => {
    const cellsMap = getCellsMap(doc)
    const handler = () => {
      const newCells = readCells(doc)
      setCells(newCells)

      if (getGameEndedAt(doc) !== null) return

      const result = findWinner(newCells, totalCells, getPlayersMap(doc))
      if (result) {
        setWinner(result)
        setGameEnded(doc)
      }
    }
    cellsMap.observe(handler)
    handler()
    return () => cellsMap.unobserve(handler)
  }, [doc, totalCells])

  // Game timer countdown
  useEffect(() => {
    const tick = () => {
      const startedAt = getGameStartedAt(doc)
      if (!startedAt) return

      const elapsed = Date.now() - startedAt
      const remaining = Math.max(0, GAME_DURATION_MS - elapsed)
      setTimeRemaining(Math.ceil(remaining / 1000))

      const alreadyEnded = getGameEndedAt(doc) !== null

      if (remaining <= 0 && !alreadyEnded) {
        // Time's up — find leader and end the game
        const currentCells = readCells(doc)
        const result = findLeaderByScore(
          currentCells,
          totalCells,
          getPlayersMap(doc)
        )
        if (result) {
          setWinner(result)
        } else {
          setWinner({ name: `Nobody`, pct: 0 })
        }
        setGameEnded(doc)
      } else if (alreadyEnded) {
        // Game already ended (refresh, or ended by bot/other player)
        setWinner((prev) => {
          if (prev) return prev
          const currentCells = readCells(doc)
          const thresholdWinner = findWinner(
            currentCells,
            totalCells,
            getPlayersMap(doc)
          )
          if (thresholdWinner) return thresholdWinner
          const topPlayer = findLeaderByScore(
            currentCells,
            totalCells,
            getPlayersMap(doc)
          )
          return topPlayer ?? { name: `Nobody`, pct: 0 }
        })
      }
    }
    const interval = setInterval(tick, 1000)
    tick()
    return () => clearInterval(interval)
  }, [doc, totalCells])

  // Observe other players
  useEffect(() => {
    const playersMap = getPlayersMap(doc)
    const handler = () => {
      setOtherPlayers(readPlayers(doc, playerId))
    }
    playersMap.observe(handler)
    handler()
    return () => playersMap.unobserve(handler)
  }, [doc, playerId])

  // Observe awareness — de-duplicate by player name, clean up departed players
  useEffect(() => {
    const handler = () => {
      const activePlayerIds = new Set<string>()
      const uniqueNames = new Set<string>([playerName])

      awareness.getStates().forEach((state, clientId) => {
        if (clientId !== awareness.clientID) {
          if (state.playerId) activePlayerIds.add(state.playerId as string)
          const name = state.user?.name as string | undefined
          if (name) uniqueNames.add(name)
        }
      })
      setConnectedCount((prev) => {
        const next = uniqueNames.size
        return prev === next ? prev : next
      })

      const playersMap = getPlayersMap(doc)
      playersMap.forEach((_, key) => {
        if (key !== playerId && !activePlayerIds.has(key)) {
          playersMap.delete(key)
        }
      })
    }
    awareness.on(`change`, handler)
    handler()
    return () => awareness.off(`change`, handler)
  }, [awareness, doc, playerId, playerName])

  // Keyboard input: track pressed keys
  useEffect(() => {
    const pressed = new Set<string>()

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key in DIR_MAP) {
        e.preventDefault()
        const wasEmpty = !dirRef.current
        pressed.add(e.key)
        dirRef.current = DIR_MAP[e.key]
        if (wasEmpty) moveRef.current?.(DIR_MAP[e.key])
      }
    }

    const handleKeyUp = (e: KeyboardEvent) => {
      pressed.delete(e.key)
      if (e.key in DIR_MAP) {
        let stillPressed = false
        for (const key of pressed) {
          if (key in DIR_MAP) {
            dirRef.current = DIR_MAP[key]
            stillPressed = true
            break
          }
        }
        if (!stillPressed) {
          dirRef.current = null
        }
      }
    }

    window.addEventListener(`keydown`, handleKeyDown)
    window.addEventListener(`keyup`, handleKeyUp)
    return () => {
      window.removeEventListener(`keydown`, handleKeyDown)
      window.removeEventListener(`keyup`, handleKeyUp)
    }
  }, [])

  // Touch controls
  const svgRef = useRef<SVGSVGElement>(null)
  const touchStartRef = useRef<{ x: number; y: number } | null>(null)
  const lastTouchMoveRef = useRef(0)
  const SWIPE_THRESHOLD = 10

  const touchMove = useCallback(
    (clientX: number, clientY: number) => {
      const now = Date.now()
      if (now - lastTouchMoveRef.current < MOVE_INTERVAL) return
      const svg = svgRef.current
      if (!svg) return
      const pt = svg.createSVGPoint()
      pt.x = clientX
      pt.y = clientY
      const ctm = svg.getScreenCTM()
      if (!ctm) return
      const svgPt = pt.matrixTransform(ctm.inverse())
      const cx = svgPt.x / CELL - 0.5
      const cy = svgPt.y / CELL - 0.5
      const ref = localRef.current
      const dx = cx - ref.x
      const dy = cy - ref.y
      if (dx === 0 && dy === 0) return
      if (Math.abs(dx) > Math.abs(dy)) {
        moveRef.current?.({ dx: dx > 0 ? 1 : -1, dy: 0 })
      } else {
        moveRef.current?.({ dx: 0, dy: dy > 0 ? 1 : -1 })
      }
      lastTouchMoveRef.current = now
    },
    [CELL]
  )

  const onTouchStart = useCallback(
    (e: React.TouchEvent) => {
      e.preventDefault()
      const t = e.touches[0]
      touchStartRef.current = { x: t.clientX, y: t.clientY }
      touchMove(t.clientX, t.clientY)
    },
    [touchMove]
  )

  const onTouchMove = useCallback(
    (e: React.TouchEvent) => {
      e.preventDefault()
      if (!touchStartRef.current) return
      const t = e.touches[0]
      const dx = t.clientX - touchStartRef.current.x
      const dy = t.clientY - touchStartRef.current.y
      if (Math.abs(dx) < SWIPE_THRESHOLD && Math.abs(dy) < SWIPE_THRESHOLD)
        return
      touchMove(t.clientX, t.clientY)
      touchStartRef.current = { x: t.clientX, y: t.clientY }
    },
    [touchMove]
  )

  const onTouchEnd = useCallback(() => {
    touchStartRef.current = null
  }, [])

  const moveRef = useRef<(dir: { dx: number; dy: number }) => void>(undefined)

  const onBoardClick = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      const svg = svgRef.current
      if (!svg) return
      const pt = svg.createSVGPoint()
      pt.x = e.clientX
      pt.y = e.clientY
      const ctm = svg.getScreenCTM()
      if (!ctm) return
      const svgPt = pt.matrixTransform(ctm.inverse())
      const cx = svgPt.x / CELL - 0.5
      const cy = svgPt.y / CELL - 0.5
      const ref = localRef.current
      const dx = cx - ref.x
      const dy = cy - ref.y
      if (dx === 0 && dy === 0) return
      if (Math.abs(dx) > Math.abs(dy)) {
        moveRef.current?.({ dx: dx > 0 ? 1 : -1, dy: 0 })
      } else {
        moveRef.current?.({ dx: 0, dy: dy > 0 ? 1 : -1 })
      }
    },
    [CELL]
  )

  const handleLeave = useCallback(() => {
    onLeave()
  }, [onLeave])

  // Movement logic
  useEffect(() => {
    const doMove = (dir: { dx: number; dy: number }) => {
      if (getGameEndedAt(doc) !== null) return

      const ref = localRef.current
      const result = executeMove(
        doc,
        playerId,
        playerName,
        { x: ref.x, y: ref.y },
        dir,
        cols,
        rows,
        ref.stunnedUntil
      )

      ref.stunnedUntil = result.stunnedUntil
      if (result.moved) {
        ref.x = result.x
        ref.y = result.y
        setLocalPos({ x: result.x, y: result.y })
        awareness.setLocalState({
          ...awareness.getLocalState(),
          x: result.x,
          y: result.y,
        })
      }
    }

    moveRef.current = doMove

    const intervalId = setInterval(() => {
      const dir = dirRef.current
      if (dir) doMove(dir)
    }, MOVE_INTERVAL)

    return () => clearInterval(intervalId)
  }, [doc, playerId, playerName, playerColor, cols, rows, awareness])

  // ============================================================================
  // Render
  // ============================================================================

  const W = cols * CELL
  const H = rows * CELL

  const copyRoom = useCallback(() => {
    navigator.clipboard.writeText(displayRoomName).catch(() => {})
    setCopied(true)
    clearTimeout(copiedTimerRef.current)
    copiedTimerRef.current = setTimeout(() => setCopied(false), 1200)
  }, [displayRoomName])

  useEffect(() => () => clearTimeout(copiedTimerRef.current), [])

  const gridLines = useMemo(() => {
    if (!showGridLines) return null
    return (
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
    )
  }, [cols, rows, W, H, CELL, showGridLines])

  // Build color map locally — me = always purple, others = sequential from PLAYER_COLORS
  const ownerColors = useMemo(() => {
    const colors = new Map<string, string>()
    colors.set(playerId, playerColor)
    // Sort other players by ID for stable ordering, assign colors in sequence
    const otherIds = [...otherPlayers.keys()].sort()
    for (let i = 0; i < otherIds.length; i++) {
      colors.set(otherIds[i], PLAYER_COLORS[i % PLAYER_COLORS.length])
    }
    return colors
  }, [playerId, playerColor, otherPlayers])

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60)
    const s = seconds % 60
    return `${m}:${s.toString().padStart(2, `0`)}`
  }

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
        @keyframes stun-pulse { 0%,100% { opacity:1 } 50% { opacity:0.2 } }
        .stunned { animation: stun-pulse 0.3s ease-in-out infinite; }
      `}</style>

      {/* Header: EXIT | name@room | TIMER | PLAYERS */}
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
          onClick={handleLeave}
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
        <span
          style={{
            color: timeRemaining <= 30 ? `#FF3D71` : PALETTE.accent,
            fontVariantNumeric: `tabular-nums`,
          }}
        >
          {formatTime(timeRemaining)}
        </span>
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
          {showPlayers && (
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
              {[
                { id: playerId, name: playerName },
                ...Array.from(otherPlayers.entries()).map(([id, p]) => ({
                  id,
                  name: p.name,
                })),
              ].map((p) => {
                const color = ownerColors.get(p.id) ?? PLAYER_COLORS[0]
                const pCells = playerScores.get(p.id) || 0
                const pPct = Math.round((pCells / totalCells) * 100)
                return (
                  <div
                    key={p.id}
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
                          background: color,
                          display: `inline-block`,
                        }}
                      />
                      {p.name}
                    </span>
                    <span style={{ color: PALETTE.accent }}>{pPct}%</span>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {/* Score row */}
      <div
        style={{
          display: `flex`,
          justifyContent: `space-between`,
          alignItems: `flex-end`,
          width: `100%`,
          maxWidth: W,
          marginBottom: 8,
          fontSize: FONT_SM,
        }}
      >
        <div>
          <span style={{ fontSize: FONT_SCORE, color: PALETTE.accent }}>
            {myPercentage}%
          </span>
          {` `}
          <span style={{ color: PALETTE.dim }}>TERRITORY</span>
        </div>
        <div style={{ textAlign: `right` }}>
          <div
            style={{
              marginBottom: leader ? 4 : 0,
              color:
                leader && leader.pct >= Math.round(WIN_THRESHOLD * 100) - 5
                  ? `#FF3D71`
                  : PALETTE.dim,
            }}
          >
            WIN AT {Math.round(WIN_THRESHOLD * 100)}%
          </div>
          {leader && (
            <div>
              <span style={{ color: PALETTE.dim }}>{leader.name}</span>
              {` `}
              <span style={{ fontSize: FONT_SCORE, color: PALETTE.accent }}>
                {leader.pct}%
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Game board */}
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onClick={onBoardClick}
        style={{
          width: `min(100%, calc(100dvh - 140px))`,
          maxWidth: W,
          height: `auto`,
          aspectRatio: `${cols} / ${rows}`,
          background: PALETTE.grid,
          border: `1px solid ${PALETTE.border}`,
          flexShrink: 0,
          userSelect: `none`,
          WebkitUserSelect: `none`,
        }}
      >
        {gridLines}

        {/* Claimed cells */}
        {Array.from(cells.entries()).map(([key, cell]) => {
          const [cx, cy] = key.split(`,`).map(Number)
          const color = ownerColors.get(cell.owner) || PALETTE.accent
          return (
            <rect
              key={key}
              x={cx * CELL}
              y={cy * CELL}
              width={CELL}
              height={CELL}
              fill={color}
              opacity={0.5}
            />
          )
        })}

        {/* Other player cursors */}
        {Array.from(otherPlayers.entries()).map(([id, p]) => {
          const isStunned =
            p.stunnedUntil != null && Date.now() < p.stunnedUntil
          const pColor = ownerColors.get(id) ?? PLAYER_COLORS[0]
          return (
            <g key={id} className={isStunned ? `stunned` : undefined}>
              <rect
                x={p.x * CELL}
                y={p.y * CELL}
                width={CELL}
                height={CELL}
                fill={pColor}
                opacity={0.7}
                stroke={pColor}
                strokeWidth={2}
              />
              <text
                x={p.x * CELL + CELL / 2}
                y={p.y * CELL - 4}
                textAnchor="middle"
                fontSize={6}
                fill={pColor}
                fontFamily="'Press Start 2P', monospace"
              >
                {p.name}
              </text>
            </g>
          )
        })}

        {/* Local player cursor */}
        {(() => {
          const isStunned =
            localRef.current.stunnedUntil > 0 &&
            Date.now() < localRef.current.stunnedUntil
          return (
            <g className={isStunned ? `stunned` : undefined}>
              <rect
                x={localPos.x * CELL}
                y={localPos.y * CELL}
                width={CELL}
                height={CELL}
                fill={playerColor}
                opacity={1}
                stroke={playerColor}
                strokeWidth={2}
              />
            </g>
          )
        })()}
      </svg>

      {/* Win overlay */}
      {winner && (
        <div
          style={{
            position: `fixed`,
            inset: 0,
            background: `rgba(27,27,31,0.9)`,
            display: `flex`,
            flexDirection: `column`,
            alignItems: `center`,
            justifyContent: `center`,
            zIndex: 10,
            fontFamily: `'Press Start 2P', monospace`,
          }}
        >
          <div
            style={{
              fontSize: 20,
              color: PALETTE.accent,
              marginBottom: 16,
              textAlign: `center`,
            }}
          >
            {winner.name === playerName ? `YOU WIN!` : `${winner.name} WINS!`}
          </div>
          <div
            style={{
              fontSize: FONT_SM,
              color: PALETTE.text,
              marginBottom: 24,
              textAlign: `center`,
            }}
          >
            {winner.pct}% OF {Math.round(WIN_THRESHOLD * 100)}% TO WIN
          </div>
          <div style={{ display: `flex`, gap: 8 }}>
            <button
              onClick={() => {
                const cellsMap = getCellsMap(doc)
                const gameState = doc.getMap(`gameState`)
                doc.transact(() => {
                  const keys = Array.from(cellsMap.keys())
                  keys.forEach((k) => cellsMap.delete(k))
                  gameState.delete(`gameStartedAt`)
                  gameState.delete(`gameEndedAt`)
                })
                setWinner(null)
                initGameTimer(doc)
              }}
              style={{
                fontFamily: `inherit`,
                fontSize: FONT_SM,
                padding: `10px 24px`,
                background: PALETTE.accent,
                color: `#000`,
                border: `none`,
                cursor: `pointer`,
                letterSpacing: 2,
              }}
            >
              REMATCH
            </button>
            <button
              onClick={handleLeave}
              style={{
                fontFamily: `inherit`,
                fontSize: FONT_SM,
                padding: `10px 24px`,
                background: `transparent`,
                color: PALETTE.accent,
                border: `1px solid ${PALETTE.accent}`,
                cursor: `pointer`,
                letterSpacing: 2,
              }}
            >
              EXIT
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
