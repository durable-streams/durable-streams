import type * as Y from "yjs"

// ============================================================================
// Types
// ============================================================================

export interface TerritoryCell {
  owner: string
  claimedAt: number
}

export interface TerritoryPlayer {
  x: number
  y: number
  name: string
  stunnedUntil?: number
}

// ============================================================================
// Constants
// ============================================================================

export const DEFAULT_COLS = 64
export const DEFAULT_ROWS = 64
export const MOVE_INTERVAL = 120
export const STUN_DURATION = 1500
export const WIN_THRESHOLD = 0.3
export const GAME_DURATION_MS = 120_000 // 2 minutes

export const HUMAN_PLAYER_COLOR = `#d0bcff`

export const PLAYER_COLORS = [
  `#FF0055`,
  `#00FF88`,
  `#FFEE00`,
  `#00CCFF`,
  `#FF6600`,
  `#00FFCC`,
  `#FF2299`,
  `#33FF00`,
  `#FF00AA`,
  `#00AAFF`,
  `#FFAA00`,
  `#CC00FF`,
  `#00FF55`,
  `#FF4400`,
  `#0066FF`,
]

export const BOT_NAMES = [
  `Blaze`,
  `Viper`,
  `Nova`,
  `Storm`,
  `Fang`,
  `Rogue`,
  `Pulse`,
  `Neon`,
  `Drift`,
  `Apex`,
  `Phantom`,
  `Bolt`,
  `Cipher`,
  `Havoc`,
  `Spark`,
  `Turbo`,
]

// ============================================================================
// Room config parsing
// ============================================================================

export function parseRoomConfig(roomId: string): {
  cols: number
  rows: number
} {
  const match = roomId.match(/__(\d+)x(\d+)(?:_(\d+)ms)?$/)
  if (match) {
    return {
      cols: parseInt(match[1]),
      rows: parseInt(match[2]),
    }
  }
  return { cols: DEFAULT_COLS, rows: DEFAULT_ROWS }
}

// ============================================================================
// Yjs map accessors
// ============================================================================

export function getCellsMap(doc: Y.Doc): Y.Map<TerritoryCell> {
  return doc.getMap(`territoryCell`)
}

export function getPlayersMap(doc: Y.Doc): Y.Map<TerritoryPlayer> {
  return doc.getMap(`players`)
}

export function getGameStateMap(doc: Y.Doc): Y.Map<number | null> {
  return doc.getMap(`gameState`)
}

export function readPlayers(
  doc: Y.Doc,
  myId: string
): Map<string, TerritoryPlayer> {
  const playersMap = getPlayersMap(doc)
  const result = new Map<string, TerritoryPlayer>()
  playersMap.forEach((val, key) => {
    if (key !== myId) {
      result.set(key, val)
    }
  })
  return result
}

export function readAllPlayers(doc: Y.Doc): Map<string, TerritoryPlayer> {
  const playersMap = getPlayersMap(doc)
  const result = new Map<string, TerritoryPlayer>()
  playersMap.forEach((val, key) => {
    result.set(key, val)
  })
  return result
}

export function readCells(doc: Y.Doc): Map<string, TerritoryCell> {
  const cellsMap = getCellsMap(doc)
  const result = new Map<string, TerritoryCell>()
  cellsMap.forEach((val, key) => {
    result.set(key, val)
  })
  return result
}

export function countCellsForPlayer(
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

export function findEnclosedCells(
  ownerId: string,
  cellsMap: Y.Map<TerritoryCell>,
  cols: number,
  rows: number
): Array<{ x: number; y: number }> {
  const ownerCells = new Set<string>()
  cellsMap.forEach((cell, key) => {
    if (cell.owner === ownerId) {
      ownerCells.add(key)
    }
  })

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

  const enclosed: Array<{ x: number; y: number }> = []
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const k = `${x},${y}`
      if (!reachable.has(k) && !ownerCells.has(k)) {
        enclosed.push({ x, y })
      }
    }
  }
  return enclosed
}

// ============================================================================
// Movement validation
// ============================================================================

/** Returns true if newPos is exactly one step (cardinal) from oldPos */
function isAdjacentMove(
  oldPos: { x: number; y: number },
  newPos: { x: number; y: number }
): boolean {
  const dx = Math.abs(newPos.x - oldPos.x)
  const dy = Math.abs(newPos.y - oldPos.y)
  return (dx === 1 && dy === 0) || (dx === 0 && dy === 1)
}

export interface MoveResult {
  moved: boolean
  stunned: boolean
}

/**
 * Validated move: enforces adjacent-only movement, collision detection,
 * cell claiming, and enclosure fill. Used by both browser and server.
 */
export function executeMove(
  doc: Y.Doc,
  playerId: string,
  playerName: string,
  currentPos: { x: number; y: number },
  dir: { dx: number; dy: number },
  cols: number,
  rows: number,
  stunnedUntil: number
): MoveResult & { x: number; y: number; stunnedUntil: number } {
  const now = Date.now()

  if (stunnedUntil && now < stunnedUntil) {
    return { moved: false, stunned: true, ...currentPos, stunnedUntil }
  }

  // Enforce direction magnitude
  const clampedDx = Math.max(-1, Math.min(1, Math.round(dir.dx)))
  const clampedDy = Math.max(-1, Math.min(1, Math.round(dir.dy)))
  if (clampedDx === 0 && clampedDy === 0) {
    return { moved: false, stunned: false, ...currentPos, stunnedUntil }
  }

  const nx = Math.max(0, Math.min(cols - 1, currentPos.x + clampedDx))
  const ny = Math.max(0, Math.min(rows - 1, currentPos.y + clampedDy))

  // Reject if not actually adjacent (e.g. clamped at boundary)
  if (nx === currentPos.x && ny === currentPos.y) {
    return { moved: false, stunned: false, ...currentPos, stunnedUntil }
  }
  if (!isAdjacentMove(currentPos, { x: nx, y: ny })) {
    return { moved: false, stunned: false, ...currentPos, stunnedUntil }
  }

  // Collision check
  const others = readPlayers(doc, playerId)
  const collidedWith = Array.from(others.entries()).find(
    ([, p]) => p.x === nx && p.y === ny
  )

  if (collidedWith) {
    const [otherId, otherPlayer] = collidedWith
    const stunUntil = now + STUN_DURATION
    const playersMap = getPlayersMap(doc)
    playersMap.set(otherId, { ...otherPlayer, stunnedUntil: stunUntil })
    playersMap.set(playerId, {
      x: currentPos.x,
      y: currentPos.y,
      name: playerName,
      stunnedUntil: stunUntil,
    })
    return {
      moved: false,
      stunned: true,
      x: currentPos.x,
      y: currentPos.y,
      stunnedUntil: stunUntil,
    }
  }

  // Move is valid — update position
  const playersMap = getPlayersMap(doc)
  playersMap.set(playerId, {
    x: nx,
    y: ny,
    name: playerName,
  })

  // Claim cell
  const cellsMap = getCellsMap(doc)
  const claimTime = Date.now()
  doc.transact(() => {
    cellsMap.set(`${nx},${ny}`, { owner: playerId, claimedAt: claimTime })
  })

  // Check enclosure
  const enclosed = findEnclosedCells(playerId, cellsMap, cols, rows)
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

  return { moved: true, stunned: false, x: nx, y: ny, stunnedUntil: 0 }
}

// ============================================================================
// Color helper
// ============================================================================

// ============================================================================
// Game state helpers
// ============================================================================

export function initGameTimer(doc: Y.Doc): void {
  const gameState = getGameStateMap(doc)
  if (!gameState.has(`gameStartedAt`)) {
    doc.transact(() => {
      if (!gameState.has(`gameStartedAt`)) {
        gameState.set(`gameStartedAt`, Date.now())
      }
    })
  }
}

export function getGameStartedAt(doc: Y.Doc): number | null {
  const gameState = getGameStateMap(doc)
  const val = gameState.get(`gameStartedAt`)
  return val !== undefined ? (val as number) : null
}

export function getGameEndedAt(doc: Y.Doc): number | null {
  const gameState = getGameStateMap(doc)
  const val = gameState.get(`gameEndedAt`)
  return val !== undefined ? (val as number) : null
}

export function setGameEnded(doc: Y.Doc): void {
  const gameState = getGameStateMap(doc)
  if (!gameState.has(`gameEndedAt`) || gameState.get(`gameEndedAt`) === null) {
    doc.transact(() => {
      gameState.set(`gameEndedAt`, Date.now())
    })
  }
}

export function getPlayerScores(
  cells: Map<string, TerritoryCell>
): Map<string, number> {
  const scores = new Map<string, number>()
  cells.forEach((cell) => {
    scores.set(cell.owner, (scores.get(cell.owner) || 0) + 1)
  })
  return scores
}

export function findWinner(
  cells: Map<string, TerritoryCell>,
  totalCells: number,
  playersMap: Y.Map<TerritoryPlayer>
): { name: string; pct: number } | null {
  const scores = getPlayerScores(cells)
  const threshold = WIN_THRESHOLD * totalCells

  // Check threshold win
  for (const [ownerId, count] of scores) {
    if (count >= threshold) {
      const ownerData = playersMap.get(ownerId)
      if (ownerData) {
        return {
          name: ownerData.name,
          pct: Math.round((count / totalCells) * 100),
        }
      }
    }
  }
  return null
}

export function findLeaderByScore(
  cells: Map<string, TerritoryCell>,
  totalCells: number,
  playersMap: Y.Map<TerritoryPlayer>
): { name: string; pct: number } | null {
  const scores = getPlayerScores(cells)
  let maxCells = 0
  let leaderId = ``
  scores.forEach((count, id) => {
    if (count > maxCells) {
      maxCells = count
      leaderId = id
    }
  })
  if (!leaderId || maxCells === 0) return null
  const ownerData = playersMap.get(leaderId)
  if (!ownerData) return null
  return {
    name: ownerData.name,
    pct: Math.round((maxCells / totalCells) * 100),
  }
}
