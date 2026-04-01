import Anthropic from "@anthropic-ai/sdk"
import type { TerritoryCell, TerritoryPlayer } from "../utils/game-logic"

function buildSystemPrompt(cols: number, rows: number): string {
  const maxX = cols - 1
  const maxY = rows - 1
  const enclosureSize = Math.max(3, Math.floor(Math.min(cols, rows) / 10))
  return `Territory Wars: ${cols}x${rows} grid (0-${maxX}, 0-${maxY}). Move one cell/step, ~8 steps/sec, ~25 steps between calls. Claim cells by moving. Closing a boundary around an area captures ALL cells inside — including opponent cells (they lose points, you gain them). First to 30% wins, or highest after 2min. Collisions stun both ~12 steps.

Pick a target coordinate. Strategy:
- Close small ${enclosureSize}x${enclosureSize} to ${enclosureSize * 2}x${enclosureSize * 2} areas — each enclosure scores you ALL the cells inside, not just the boundary
- Prefer straight lines along one axis, then turn — avoid diagonal paths
- ALWAYS expand from your existing territory edge, stay within ~${enclosureSize * 2} cells of your M cells
- Use edges and your own territory as free walls
- Enclosing opponent (O) cells is very valuable — you take all their points inside
- Avoid players (X). Avoid walking over your own cells

JSON only: { "target": { "x": <0-${maxX}>, "y": <0-${maxY}> }, "strategy": "<reason>" }`
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
  asciiMap: string
  nearbyPlayers: Array<{
    name: string
    x: number
    y: number
    distance: number
    territory: number
  }>
}

// Target ~32 chars wide max for the ASCII map
const MAX_ASCII_SIZE = 32

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

  // Build ASCII map: downsample board to max MAX_ASCII_SIZE
  // . = empty, M = mine, O = opponent, @ = my position, X = other player
  const scale = Math.max(1, Math.ceil(Math.max(cols, rows) / MAX_ASCII_SIZE))
  const mapCols = Math.ceil(cols / scale)
  const mapRows = Math.ceil(rows / scale)
  const mapLines: Array<string> = []

  for (let my = 0; my < mapRows; my++) {
    let row = ``
    for (let mx = 0; mx < mapCols; mx++) {
      const startX = mx * scale
      const startY = my * scale
      const endX = Math.min(startX + scale, cols)
      const endY = Math.min(startY + scale, rows)
      const cellCount = (endX - startX) * (endY - startY)

      let mine = 0
      let opponent = 0
      for (let y = startY; y < endY; y++) {
        for (let x = startX; x < endX; x++) {
          const cell = cells.get(`${x},${y}`)
          if (cell) {
            if (cell.owner === myId) mine++
            else opponent++
          }
        }
      }

      // Check if my position or another player is in this cell
      const myMapX = Math.floor(myPosition.x / scale)
      const myMapY = Math.floor(myPosition.y / scale)
      if (mx === myMapX && my === myMapY) {
        row += `@`
      } else {
        const hasPlayer = Array.from(players.entries()).some(
          ([id, p]) =>
            id !== myId &&
            Math.floor(p.x / scale) === mx &&
            Math.floor(p.y / scale) === my
        )
        if (hasPlayer) row += `X`
        else if (mine > cellCount / 2) row += `M`
        else if (opponent > cellCount / 2) row += `O`
        else if (mine > 0 || opponent > 0) row += `~`
        else row += `.`
      }
    }
    mapLines.push(row)
  }

  const asciiMap = mapLines.join(`\n`)

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
    asciiMap,
    nearbyPlayers: nearbyPlayers.slice(0, 5),
  }
}

function formatSummary(summary: BoardSummary): string {
  const scale = Math.max(
    1,
    Math.ceil(Math.max(summary.cols, summary.rows) / MAX_ASCII_SIZE)
  )
  const lines: Array<string> = []
  lines.push(
    `Pos: (${summary.position.x},${summary.position.y}) | ${summary.myTerritory}% rank ${summary.rank}/${summary.totalPlayers} | ${summary.timeRemainingSeconds}s left`
  )
  lines.push(``)
  lines.push(
    `Map (1 char = ${scale}x${scale} cells): .=empty M=mine O=opponent ~=mixed @=me X=player`
  )
  lines.push(summary.asciiMap)

  if (summary.nearbyPlayers.length > 0) {
    lines.push(``)
    lines.push(`Players:`)
    for (const p of summary.nearbyPlayers) {
      lines.push(`  ${p.name} (${p.x},${p.y}) d=${p.distance} ${p.territory}%`)
    }
  }

  return lines.join(`\n`)
}

export class HaikuClient {
  private client: Anthropic

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey })
  }

  async getStrategy(
    summary: BoardSummary,
    playerName?: string
  ): Promise<StrategyResponse> {
    const userMessage = formatSummary(summary)
    const systemPrompt = buildSystemPrompt(summary.cols, summary.rows)

    const tag = playerName ?? `Haiku`
    console.log(`[${tag}] Board sent to LLM:\n${userMessage}`)

    const response = await this.client.messages.create({
      model: `claude-haiku-4-5-20251001`,
      max_tokens: 150,
      system: systemPrompt,
      messages: [{ role: `user`, content: userMessage }],
    })

    const text =
      response.content[0].type === `text` ? response.content[0].text : ``
    console.log(`[${tag}] LLM response: ${text}`)

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
