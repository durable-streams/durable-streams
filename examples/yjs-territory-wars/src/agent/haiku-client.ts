import Anthropic from "@anthropic-ai/sdk"
import type { TerritoryCell, TerritoryPlayer } from "../utils/game-logic"

function buildSystemPrompt(cols: number, rows: number): string {
  const maxX = cols - 1
  const maxY = rows - 1
  return `You are an AI player in Territory Wars, a multiplayer grid-based territory capture game.

Rules:
- The board is a ${cols}x${rows} grid (coordinates 0-${maxX} for x, 0-${maxY} for y)
- You can only move one cell per step to an adjacent cell (up/down/left/right)
- You cannot jump or teleport — movement is always to a neighboring cell
- You move at a rate of ~8 steps per second (one step every 120ms)
- You get a new strategy target every 3 seconds (~25 steps between strategy calls)
- Every cell you move to is claimed as yours
- If you form a closed boundary around empty cells, they are auto-filled as yours
- Colliding with another player stuns both for 1.5 seconds (~12 lost steps)
- First to 20% territory wins, or highest % after 2 minutes
- Cells from disconnected players become reclaimable

Strategy — IMPORTANT, focus on small enclosures:
- You can travel ~25 cells between strategy calls — pick targets within that range
- Close SMALL areas (5x5 to 10x10 rectangles) rather than large ones — small enclosures are faster to complete and less likely to be interrupted
- Walk along a board edge or your own trail, then turn perpendicular to close a rectangle
- A board edge acts as a free wall — use corners and edges to minimize steps needed
- Avoid other players to prevent stun (losing ~12 steps is very costly)
- After completing one enclosure, pick an adjacent unclaimed area and repeat
- Prioritize unclaimed regions near your existing territory to expand outward
- With 2 minutes and ~8 steps/sec you have ~960 total steps — many small enclosures beat one large attempt

Respond with JSON only: { "target": { "x": <int 0-${maxX}>, "y": <int 0-${maxY}> }, "strategy": "<brief reason>" }`
}

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
  cols: number
  rows: number
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

function computeSectorSize(cols: number, rows: number): number {
  const maxDim = Math.max(cols, rows)
  if (maxDim <= 32) return 8
  if (maxDim <= 64) return 16
  return 32
}

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

  const playerCounts = new Map<string, number>()
  cells.forEach((cell) => {
    playerCounts.set(cell.owner, (playerCounts.get(cell.owner) || 0) + 1)
  })
  const myCells = playerCounts.get(myId) || 0
  const myTerritory = Math.round((myCells / totalCells) * 100)

  const sortedScores = [...playerCounts.entries()].sort((a, b) => b[1] - a[1])
  const rank =
    sortedScores.findIndex(([id]) => id === myId) + 1 || sortedScores.length + 1

  const sectorSize = computeSectorSize(cols, rows)
  const sectorGridCols = Math.ceil(cols / sectorSize)
  const sectorGridRows = Math.ceil(rows / sectorSize)
  const sectors: BoardSummary[`sectors`] = []

  for (let sr = 0; sr < sectorGridRows; sr++) {
    for (let sc = 0; sc < sectorGridCols; sc++) {
      let mine = 0
      let opponent = 0

      const startX = sc * sectorSize
      const startY = sr * sectorSize
      const endX = Math.min(startX + sectorSize, cols)
      const endY = Math.min(startY + sectorSize, rows)
      const cellCount = (endX - startX) * (endY - startY)

      for (let y = startY; y < endY; y++) {
        for (let x = startX; x < endX; x++) {
          const cell = cells.get(`${x},${y}`)
          if (cell) {
            if (cell.owner === myId) mine++
            else opponent++
          }
        }
      }

      const unclaimed = cellCount - mine - opponent
      const unclaimedPct = Math.round((unclaimed / cellCount) * 100)
      const minePct = Math.round((mine / cellCount) * 100)
      const opponentPct = Math.round((opponent / cellCount) * 100)

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

  const nearbyPlayers: BoardSummary[`nearbyPlayers`] = []
  const nearbyRange = Math.max(cols, rows)
  players.forEach((p, id) => {
    if (id === myId) return
    const dist = Math.abs(p.x - myPosition.x) + Math.abs(p.y - myPosition.y)
    if (dist <= nearbyRange) {
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
    cols,
    rows,
    sectors,
    nearbyPlayers: nearbyPlayers.slice(0, 5),
  }
}

function formatSummary(summary: BoardSummary): string {
  const sectorSize = computeSectorSize(summary.cols, summary.rows)
  const lines: Array<string> = []
  lines.push(`Board: ${summary.cols}x${summary.rows}`)
  lines.push(`Position: (${summary.position.x}, ${summary.position.y})`)
  lines.push(
    `Territory: ${summary.myTerritory}% (rank ${summary.rank} of ${summary.totalPlayers})`
  )
  lines.push(`Time remaining: ${summary.timeRemainingSeconds}s`)
  lines.push(``)

  if (summary.sectors.length > 0) {
    lines.push(`Sector map (each sector is ${sectorSize}x${sectorSize} cells):`)
    for (const s of summary.sectors) {
      lines.push(
        `  [${s.row},${s.col}]: unclaimed=${s.unclaimed}% mine=${s.mine}% opponent=${s.opponent}%`
      )
    }
    lines.push(``)
  }

  if (summary.nearbyPlayers.length > 0) {
    lines.push(`Nearby players:`)
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
    const systemPrompt = buildSystemPrompt(summary.cols, summary.rows)

    const response = await this.client.messages.create({
      model: `claude-haiku-4-5-20251001`,
      max_tokens: 150,
      system: systemPrompt,
      messages: [{ role: `user`, content: userMessage }],
    })

    const text =
      response.content[0].type === `text` ? response.content[0].text : ``

    try {
      const parsed = JSON.parse(text) as StrategyResponse
      if (
        typeof parsed.target.x === `number` &&
        typeof parsed.target.y === `number` &&
        parsed.target.x >= 0 &&
        parsed.target.x < summary.cols &&
        parsed.target.y >= 0 &&
        parsed.target.y < summary.rows
      ) {
        return parsed
      }
    } catch {
      // Fall through to fallback
    }

    return {
      target: {
        x: Math.floor(Math.random() * summary.cols),
        y: Math.floor(Math.random() * summary.rows),
      },
      strategy: `random fallback`,
    }
  }
}
