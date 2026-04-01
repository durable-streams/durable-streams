import Anthropic from "@anthropic-ai/sdk"
import type { TerritoryCell, TerritoryPlayer } from "../utils/game-logic"

export type AgentPersonality = `destroyer` | `explorer` | `greedy` | `balanced`

function buildSystemPrompt(
  cols: number,
  rows: number,
  personality: AgentPersonality
): string {
  const maxX = cols - 1
  const maxY = rows - 1
  const enc = Math.max(3, Math.floor(Math.min(cols, rows) / 10))
  const maxDist = enc * 2

  const base = `Territory Wars: ${cols}x${rows} grid. Claim cells by moving. Closing a boundary captures ALL cells inside (steals opponents'). First to 30% wins. Stun on collision ~12 steps.`

  const strategies: Record<AgentPersonality, string> = {
    destroyer: `PRIORITY: Destroy opponents' territory. Target areas dense with O cells. Route your boundary around their clusters to steal maximum cells. Enclosing even a few opponent cells is worth more than claiming empty space. Hunt the leader.`,

    explorer: `PRIORITY: Claim large unclaimed areas quickly. Push into empty (.) regions of the map, especially corners and edges. Take risks — go for bigger ${enc * 2}x${enc * 2} enclosures in open space. Speed over safety.`,

    greedy: `PRIORITY: Maximize cells per move. Only make tiny ${enc}x${enc} rectangles that you can close in one turn. Use edges and your own territory as walls. Never go far from your M cells. Efficiency over ambition.`,

    balanced: `PRIORITY: Expand steadily from your territory. Close small ${enc}x${enc} to ${enc * 2}x${enc * 2} rectangles. Steal O cells when nearby, but prefer unclaimed areas. Stay close to your M cells.`,
  }

  return `${base}

${strategies[personality]}

RULES: Target within ${maxDist} cells of @. Expand from M cells. Avoid X players and your own M cells.

RESPOND WITH ONLY THIS JSON, NO OTHER TEXT:
{"target":{"x":<0-${maxX}>,"y":<0-${maxY}>},"strategy":"<reason>"}`
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
    playerName?: string,
    personality: AgentPersonality = `balanced`
  ): Promise<StrategyResponse> {
    const userMessage = formatSummary(summary)
    const systemPrompt = buildSystemPrompt(
      summary.cols,
      summary.rows,
      personality
    )

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
      // Extract JSON from response (model may add reasoning text before it)
      const jsonMatch = text.match(/\{[\s\S]*\}/)
      const parsed = JSON.parse(
        jsonMatch ? jsonMatch[0] : text
      ) as StrategyResponse
      if (
        typeof parsed.target.x === `number` &&
        typeof parsed.target.y === `number` &&
        parsed.target.x >= 0 &&
        parsed.target.x < summary.cols &&
        parsed.target.y >= 0 &&
        parsed.target.y < summary.rows
      ) {
        // Clamp target distance to maxDist from current position
        const enclosureSize = Math.max(
          3,
          Math.floor(Math.min(summary.cols, summary.rows) / 10)
        )
        const maxDist = enclosureSize * 2
        const dx = parsed.target.x - summary.position.x
        const dy = parsed.target.y - summary.position.y
        const dist = Math.abs(dx) + Math.abs(dy)
        if (dist > maxDist) {
          const ratio = maxDist / dist
          parsed.target.x = Math.round(summary.position.x + dx * ratio)
          parsed.target.y = Math.round(summary.position.y + dy * ratio)
          parsed.target.x = Math.max(
            0,
            Math.min(summary.cols - 1, parsed.target.x)
          )
          parsed.target.y = Math.max(
            0,
            Math.min(summary.rows - 1, parsed.target.y)
          )
          console.log(`[${tag}] Clamped target from dist ${dist} to ${maxDist}`)
        }
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
