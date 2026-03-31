import Anthropic from "@anthropic-ai/sdk"
import type { TerritoryCell, TerritoryPlayer } from "../utils/game-logic"

const SYSTEM_PROMPT = `You are an AI player in Territory Wars, a multiplayer grid-based territory capture game.

Rules:
- The board is a 128x128 grid (coordinates 0-127)
- You can only move one cell per step to an adjacent cell (up/down/left/right)
- You cannot jump or teleport — movement is always to a neighboring cell
- Every cell you move to is claimed as yours
- If you form a closed boundary around empty cells, they are auto-filled as yours
- Colliding with another player stuns both for 1.5 seconds
- First to 20% territory wins, or highest % after 2 minutes
- Cells from disconnected players become reclaimable

Strategy tips:
- Enclosing large empty areas is the fastest way to gain territory
- Avoid other players to prevent stun
- Work edges and borders to create enclosures efficiently
- Prioritize unclaimed regions over stealing from opponents
- Move toward the nearest large unclaimed area
- Try to create rectangular enclosures along board edges for efficiency
- Your target should be reachable by walking adjacent cells — pick nearby targets

Respond with JSON only: { "target": { "x": <int 0-127>, "y": <int 0-127> }, "strategy": "<brief reason>" }`

interface StrategyResponse {
  target: { x: number; y: number }
  strategy: string
}

interface BoardSummary {
  position: { x: number; y: number }
  myTerritory: number
  rank: number
  totalPlayers: number
  timeRemainingSeconds: number
  sectors: Array<{
    row: number
    col: number
    unclaimed: number
    mine: number
    opponent: number
  }>
  nearbyPlayers: Array<{
    name: string
    x: number
    y: number
    distance: number
    territory: number
  }>
}

const SECTOR_SIZE = 32
const SECTOR_GRID = 4 // 128 / 32

export function buildBoardSummary(
  myPosition: { x: number; y: number },
  myId: string,
  cells: Map<string, TerritoryCell>,
  players: Map<string, TerritoryPlayer>,
  cols: number,
  rows: number,
  timeRemainingMs: number
): BoardSummary {
  const totalCells = cols * rows

  // Count territory per player
  const playerCounts = new Map<string, number>()
  cells.forEach((cell) => {
    playerCounts.set(cell.owner, (playerCounts.get(cell.owner) || 0) + 1)
  })
  const myCells = playerCounts.get(myId) || 0
  const myTerritory = Math.round((myCells / totalCells) * 100)

  // Rank
  const sortedScores = [...playerCounts.entries()].sort((a, b) => b[1] - a[1])
  const rank =
    sortedScores.findIndex(([id]) => id === myId) + 1 || sortedScores.length + 1

  // Sector analysis (4x4 grid, each sector 32x32 cells)
  const sectorCellCount = SECTOR_SIZE * SECTOR_SIZE
  const sectors: BoardSummary[`sectors`] = []

  for (let sr = 0; sr < SECTOR_GRID; sr++) {
    for (let sc = 0; sc < SECTOR_GRID; sc++) {
      let mine = 0
      let opponent = 0

      const startX = sc * SECTOR_SIZE
      const startY = sr * SECTOR_SIZE
      const endX = Math.min(startX + SECTOR_SIZE, cols)
      const endY = Math.min(startY + SECTOR_SIZE, rows)

      for (let y = startY; y < endY; y++) {
        for (let x = startX; x < endX; x++) {
          const cell = cells.get(`${x},${y}`)
          if (cell) {
            if (cell.owner === myId) mine++
            else opponent++
          }
        }
      }

      const unclaimed = sectorCellCount - mine - opponent
      const unclaimedPct = Math.round((unclaimed / sectorCellCount) * 100)
      const minePct = Math.round((mine / sectorCellCount) * 100)
      const opponentPct = Math.round((opponent / sectorCellCount) * 100)

      // Only include sectors with meaningful activity
      if (minePct > 5 || opponentPct > 5 || unclaimedPct > 80) {
        sectors.push({
          row: sr,
          col: sc,
          unclaimed: unclaimedPct,
          mine: minePct,
          opponent: opponentPct,
        })
      }
    }
  }

  // Nearby players (within 100 cells)
  const nearbyPlayers: BoardSummary[`nearbyPlayers`] = []
  players.forEach((p, id) => {
    if (id === myId) return
    const dist = Math.abs(p.x - myPosition.x) + Math.abs(p.y - myPosition.y)
    if (dist <= 100) {
      const pCells = playerCounts.get(id) || 0
      nearbyPlayers.push({
        name: p.name,
        x: p.x,
        y: p.y,
        distance: dist,
        territory: Math.round((pCells / totalCells) * 100),
      })
    }
  })
  nearbyPlayers.sort((a, b) => a.distance - b.distance)

  return {
    position: myPosition,
    myTerritory,
    rank,
    totalPlayers: players.size,
    timeRemainingSeconds: Math.max(0, Math.ceil(timeRemainingMs / 1000)),
    sectors,
    nearbyPlayers: nearbyPlayers.slice(0, 5),
  }
}

function formatSummary(summary: BoardSummary): string {
  const lines: Array<string> = []
  lines.push(`Position: (${summary.position.x}, ${summary.position.y})`)
  lines.push(
    `Territory: ${summary.myTerritory}% (rank ${summary.rank} of ${summary.totalPlayers})`
  )
  lines.push(`Time remaining: ${summary.timeRemainingSeconds}s`)
  lines.push(``)

  if (summary.sectors.length > 0) {
    lines.push(`Sector map (4x4 grid, each sector is 32x32 cells):`)
    for (const s of summary.sectors) {
      lines.push(
        `  [${s.row},${s.col}]: unclaimed=${s.unclaimed}% mine=${s.mine}% opponent=${s.opponent}%`
      )
    }
    lines.push(``)
  }

  if (summary.nearbyPlayers.length > 0) {
    lines.push(`Nearby players (within 100 cells):`)
    for (const p of summary.nearbyPlayers) {
      lines.push(
        `  - "${p.name}" at (${p.x},${p.y}), distance ${p.distance}, territory ${p.territory}%`
      )
    }
  }

  return lines.join(`\n`)
}

export class HaikuClient {
  private client: Anthropic

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey })
  }

  async getStrategy(summary: BoardSummary): Promise<StrategyResponse> {
    const userMessage = formatSummary(summary)

    const response = await this.client.messages.create({
      model: `claude-haiku-4-5-20251001`,
      max_tokens: 150,
      system: SYSTEM_PROMPT,
      messages: [{ role: `user`, content: userMessage }],
    })

    const text =
      response.content[0].type === `text` ? response.content[0].text : ``

    try {
      const parsed = JSON.parse(text) as StrategyResponse
      // Validate bounds
      if (
        typeof parsed.target.x === `number` &&
        typeof parsed.target.y === `number` &&
        parsed.target.x >= 0 &&
        parsed.target.x < 128 &&
        parsed.target.y >= 0 &&
        parsed.target.y < 128
      ) {
        return parsed
      }
    } catch {
      // Fall through to fallback
    }

    // Fallback: pick a random position
    return {
      target: {
        x: Math.floor(Math.random() * 128),
        y: Math.floor(Math.random() * 128),
      },
      strategy: `random fallback`,
    }
  }
}
