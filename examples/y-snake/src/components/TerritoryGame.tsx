import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useGameRoom } from "./game-room-context"
import type * as Y from "yjs"

// ============================================================================
// Constants
// ============================================================================

const CELL = 14
const DEFAULT_COLS = 30
const DEFAULT_ROWS = 25
const MOVE_INTERVAL = 120
const STUN_DURATION = 1500
const WIN_THRESHOLD = 0.5
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
// Types
// ============================================================================

interface TerritoryCell {
  owner: string
  claimedAt: number
}

interface TerritoryPlayer {
  x: number
  y: number
  name: string
  color: string
  stunnedUntil?: number
}

// ============================================================================
// Helpers
// ============================================================================

function parseRoomConfig(roomId: string): { cols: number; rows: number } {
  const match = roomId.match(/__(\d+)x(\d+)(?:_(\d+)ms)?$/)
  if (match) {
    return {
      cols: parseInt(match[1]),
      rows: parseInt(match[2]),
    }
  }
  return { cols: DEFAULT_COLS, rows: DEFAULT_ROWS }
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
// Yjs helpers
// ============================================================================

function getCellsMap(doc: Y.Doc): Y.Map<TerritoryCell> {
  return doc.getMap(`territoryCell`)
}

function getPlayersMap(doc: Y.Doc): Y.Map<TerritoryPlayer> {
  return doc.getMap(`players`)
}

function readPlayers(doc: Y.Doc, myId: string): Map<string, TerritoryPlayer> {
  const playersMap = getPlayersMap(doc)
  const result = new Map<string, TerritoryPlayer>()
  playersMap.forEach((val, key) => {
    if (key !== myId) {
      result.set(key, val)
    }
  })
  return result
}

function readCells(doc: Y.Doc): Map<string, TerritoryCell> {
  const cellsMap = getCellsMap(doc)
  const result = new Map<string, TerritoryCell>()
  cellsMap.forEach((val, key) => {
    result.set(key, val)
  })
  return result
}

function countCellsForPlayer(
  cells: Map<string, TerritoryCell>,
  playerId: string
): number {
  let count = 0
  cells.forEach((cell) => {
    if (cell.owner === playerId) count++
  })
  return count
}

// ============================================================================
// Territory fill: flood-fill to find enclosed empty regions
// ============================================================================

function findEnclosedCells(
  ownerId: string,
  cellsMap: Y.Map<TerritoryCell>,
  cols: number,
  rows: number,
  activePlayers: Set<string>
): Array<{ x: number; y: number }> {
  // Build sets for quick lookup
  const ownerCells = new Set<string>()
  const activeOtherCells = new Set<string>()
  cellsMap.forEach((cell, key) => {
    if (cell.owner === ownerId) {
      ownerCells.add(key)
    } else if (activePlayers.has(cell.owner)) {
      // Only treat cells from active players as blocking
      activeOtherCells.add(key)
    }
    // Cells from departed players are treated as empty (claimable)
  })

  // Flood-fill from all edge cells, treating owner's cells as walls
  const reachable = new Set<string>()
  const queue: Array<{ x: number; y: number }> = []

  for (let x = 0; x < cols; x++) {
    for (const y of [0, rows - 1]) {
      const k = `${x},${y}`
      if (!ownerCells.has(k) && !reachable.has(k)) {
        reachable.add(k)
        queue.push({ x, y })
      }
    }
  }
  for (let y = 0; y < rows; y++) {
    for (const x of [0, cols - 1]) {
      const k = `${x},${y}`
      if (!ownerCells.has(k) && !reachable.has(k)) {
        reachable.add(k)
        queue.push({ x, y })
      }
    }
  }

  while (queue.length > 0) {
    const { x, y } = queue.pop()!
    for (const [dx, dy] of [
      [0, -1],
      [0, 1],
      [-1, 0],
      [1, 0],
    ]) {
      const nx = x + dx
      const ny = y + dy
      if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue
      const nk = `${nx},${ny}`
      if (ownerCells.has(nk) || reachable.has(nk)) continue
      reachable.add(nk)
      queue.push({ x: nx, y: ny })
    }
  }

  // Enclosed = not reachable, not ours, and no active other player's cell
  const enclosed: Array<{ x: number; y: number }> = []
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const k = `${x},${y}`
      if (!reachable.has(k) && !ownerCells.has(k) && !activeOtherCells.has(k)) {
        enclosed.push({ x, y })
      }
    }
  }
  return enclosed
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
  const [winner, setWinner] = useState<string | null>(null)
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

  // Compute all player scores for the tooltip and high score display
  const playerScores = useMemo(() => {
    const scores = new Map<string, number>()
    cells.forEach((cell) => {
      scores.set(cell.owner, (scores.get(cell.owner) || 0) + 1)
    })
    return scores
  }, [cells])

  // Find the leading player
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
    // Find name
    if (leaderId === playerId) return { name: playerName, pct: leaderPct }
    const other = otherPlayers.get(leaderId)
    return other ? { name: other.name, pct: leaderPct } : null
  }, [playerScores, totalCells, playerId, playerName, otherPlayers])

  // Initialize player position
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
      color: playerColor,
    })

    // Claim the starting cell
    const cellsMap = getCellsMap(doc)
    doc.transact(() => {
      cellsMap.set(`${startX},${startY}`, {
        owner: playerId,
        claimedAt: Date.now(),
      })
    })

    return () => {
      playersMap.delete(playerId)
    }
  }, [doc, playerId, playerName, playerColor, cols, rows])

  // Observe cells
  useEffect(() => {
    const cellsMap = getCellsMap(doc)
    const handler = () => {
      const newCells = readCells(doc)
      setCells(newCells)

      // Check win condition
      const scores = new Map<string, number>()
      newCells.forEach((cell) => {
        scores.set(cell.owner, (scores.get(cell.owner) || 0) + 1)
      })
      const threshold = WIN_THRESHOLD * totalCells
      scores.forEach((count, ownerId) => {
        if (count >= threshold) {
          // Find owner name
          const playersMap = getPlayersMap(doc)
          const ownerData = playersMap.get(ownerId)
          if (ownerData) {
            setWinner(ownerData.name)
          } else if (ownerId === playerId) {
            setWinner(playerName)
          }
        }
      })
    }
    cellsMap.observe(handler)
    handler()
    return () => cellsMap.unobserve(handler)
  }, [doc, totalCells, playerId, playerName])

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
        // Immediate move on first keypress (don't wait for interval)
        if (wasEmpty) moveRef.current?.(DIR_MAP[e.key])
      }
    }

    const handleKeyUp = (e: KeyboardEvent) => {
      pressed.delete(e.key)
      // If no direction keys are pressed, stop moving
      if (e.key in DIR_MAP) {
        // Check if any other direction key is still pressed
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

  // Touch controls — rate-limited to MOVE_INTERVAL like keyboard
  const svgRef = useRef<SVGSVGElement>(null)
  const touchStartRef = useRef<{ x: number; y: number } | null>(null)
  const lastTouchMoveRef = useRef(0)
  const SWIPE_THRESHOLD = 10

  const touchMove = useCallback((clientX: number, clientY: number) => {
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
  }, [])

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

  // Mouse click — click an adjacent cell to move there (one step)
  const moveRef = useRef<(dir: { dx: number; dy: number }) => void>(undefined)

  const onBoardClick = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
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
    // Move one step in the cardinal direction closest to the click
    if (Math.abs(dx) > Math.abs(dy)) {
      moveRef.current?.({ dx: dx > 0 ? 1 : -1, dy: 0 })
    } else {
      moveRef.current?.({ dx: 0, dy: dy > 0 ? 1 : -1 })
    }
  }, [])

  const handleLeave = useCallback(() => {
    onLeave()
  }, [onLeave])

  // Movement logic — shared by keyboard interval and mouse click
  useEffect(() => {
    const doMove = (dir: { dx: number; dy: number }) => {
      const ref = localRef.current
      const now = Date.now()

      if (ref.stunnedUntil && now < ref.stunnedUntil) return

      const nx = Math.max(0, Math.min(cols - 1, ref.x + dir.dx))
      const ny = Math.max(0, Math.min(rows - 1, ref.y + dir.dy))
      if (nx === ref.x && ny === ref.y) return

      const others = readPlayers(doc, playerId)
      const collidedWith = Array.from(others.entries()).find(
        ([, p]) => p.x === nx && p.y === ny
      )

      if (collidedWith) {
        const [otherId, otherPlayer] = collidedWith
        const stunUntil = now + STUN_DURATION
        ref.stunnedUntil = stunUntil

        const playersMap = getPlayersMap(doc)
        playersMap.set(otherId, { ...otherPlayer, stunnedUntil: stunUntil })
        playersMap.set(playerId, {
          x: ref.x,
          y: ref.y,
          name: playerName,
          color: playerColor,
          stunnedUntil: stunUntil,
        })
        return
      }

      ref.x = nx
      ref.y = ny
      setLocalPos({ x: nx, y: ny })

      // Update awareness on move to keep presence fresh
      awareness.setLocalState({
        ...awareness.getLocalState(),
        x: nx,
        y: ny,
      })

      const playersMap = getPlayersMap(doc)
      playersMap.set(playerId, {
        x: nx,
        y: ny,
        name: playerName,
        color: playerColor,
      })

      const cellsMap = getCellsMap(doc)
      const claimTime = Date.now()
      doc.transact(() => {
        cellsMap.set(`${nx},${ny}`, {
          owner: playerId,
          claimedAt: claimTime,
        })
      })

      // Check for enclosed regions and fill them
      // Departed players' cells are treated as empty (claimable)
      const activePlayers = new Set<string>([playerId])
      readPlayers(doc, playerId).forEach((_, id) => activePlayers.add(id))
      const enclosed = findEnclosedCells(
        playerId,
        cellsMap,
        cols,
        rows,
        activePlayers
      )
      if (enclosed.length > 0) {
        doc.transact(() => {
          for (const cell of enclosed) {
            cellsMap.set(`${cell.x},${cell.y}`, {
              owner: playerId,
              claimedAt: claimTime,
            })
          }
        })
      }
    }

    // Expose for click handler
    moveRef.current = doMove

    // Keyboard repeat interval
    const intervalId = setInterval(() => {
      const dir = dirRef.current
      if (dir) doMove(dir)
    }, MOVE_INTERVAL)

    return () => clearInterval(intervalId)
  }, [doc, playerId, playerName, playerColor, cols, rows])

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

  // Build a color lookup for owners
  const ownerColors = useMemo(() => {
    const colors = new Map<string, string>()
    colors.set(playerId, playerColor)
    otherPlayers.forEach((p, id) => {
      colors.set(id, p.color)
    })
    return colors
  }, [playerId, playerColor, otherPlayers])

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
                { id: playerId, name: playerName, color: playerColor },
                ...Array.from(otherPlayers.entries()).map(([id, p]) => ({
                  id,
                  name: p.name,
                  color: p.color,
                })),
              ].map((p) => {
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
                          background: p.color,
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
          width: `100%`,
          maxWidth: W,
          height: `auto`,
          background: PALETTE.grid,
          border: `1px solid ${PALETTE.border}`,
          flex: `1 1 auto`,
          minHeight: 0,
          maxHeight: `calc(100dvh - 120px)`,
          objectFit: `contain`,
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
          return (
            <g key={id} className={isStunned ? `stunned` : undefined}>
              <rect
                x={p.x * CELL}
                y={p.y * CELL}
                width={CELL}
                height={CELL}
                fill={p.color}
                opacity={0.7}
                stroke={p.color}
                strokeWidth={2}
              />
              <text
                x={p.x * CELL + CELL / 2}
                y={p.y * CELL - 4}
                textAnchor="middle"
                fontSize={6}
                fill={p.color}
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
            {winner === playerName ? `YOU WIN!` : `${winner} WINS!`}
          </div>
          <div
            style={{
              fontSize: FONT_SM,
              color: PALETTE.text,
              marginBottom: 24,
              textAlign: `center`,
            }}
          >
            {WIN_THRESHOLD * 100}% TERRITORY CLAIMED
          </div>
          <div style={{ display: `flex`, gap: 8 }}>
            <button
              onClick={() => {
                const cellsMap = getCellsMap(doc)
                doc.transact(() => {
                  const keys = Array.from(cellsMap.keys())
                  keys.forEach((k) => cellsMap.delete(k))
                })
                setWinner(null)
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
