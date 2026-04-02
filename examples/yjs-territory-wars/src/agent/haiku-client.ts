import Anthropic from "@anthropic-ai/sdk"
import type { TerritoryCell, TerritoryPlayer } from "../utils/game-logic"

export type AgentPersonality =
  | `destroyer`
  | `explorer`
  | `greedy`
  | `balanced`
  | `wall-builder`
  | `opportunist`
  | `edge-runner`

function buildSystemPrompt(
  cols: number,
  rows: number,
  personality: AgentPersonality
): string {
  const maxX = cols - 1
  const maxY = rows - 1
  const enc = Math.max(3, Math.floor(Math.min(cols, rows) / 10))
  const maxDist = enc * 2

  const base = `Territory Wars: ${cols}x${rows} grid. Claim cells by moving. Closing a boundary captures ALL cells inside (steals opponents'). First to 30% wins. Stun on collision ~8 steps.`

  const strategies: Record<AgentPersonality, string> = {
    destroyer: `PRIORITY: Systematically dismantle the largest opponent territory. Find the biggest cluster of O cells on the map and work to enclose it. Build your boundary around one side of their cluster at a time. Continue your previous plan if you were already building a boundary — don't restart. Each turn should extend the enclosure wall. Once closed, all their cells become yours.`,

    explorer: `PRIORITY: Occupy large empty areas. Find the biggest cluster of . cells on the map and move there. Enclose wide empty rectangles to claim maximum territory per turn. Corners and edges are free walls — use them. Go for ${enc * 2}x${enc * 2} enclosures in open space. Continue expanding in the same direction as your previous plan.`,

    greedy: `PRIORITY: Maximize cells per move. Only make tiny ${enc}x${enc} rectangles that you can close in one turn. Use edges and your own territory as walls. Never go far from your M cells. Finish your current rectangle before starting a new one.`,

    balanced: `PRIORITY: Expand steadily from your territory. Close small ${enc}x${enc} to ${enc * 2}x${enc * 2} rectangles. Steal O cells when nearby, but prefer unclaimed areas. Stay close to your M cells. Continue your previous enclosure if not finished.`,

    "wall-builder": `PRIORITY: Build long walls along board edges and through the center to divide the map. Claim entire rows or columns by running straight lines. Use these walls as boundaries for enclosures later. Prefer horizontal or vertical paths that span many cells. You are creating infrastructure for future captures.`,

    opportunist: `PRIORITY: React to what other players are doing. If an opponent is building a boundary, race to break it by claiming cells in their path. If someone left a gap in their enclosure, rush there. If the leader has a thin boundary, cut through it. Always target the most impactful move — disrupt others' plans rather than building your own.`,

    "edge-runner": `PRIORITY: Claim the board perimeter first. Run along the edges (x=0, x=${maxX}, y=0, y=${maxY}) to build a frame. Once you own the edges, make enclosures inward — every rectangle touching an edge needs only 3 walls. Start from your nearest corner and work around the board.`,
  }

  return `${base}

${strategies[personality]}

RULES: Each waypoint within ${maxDist} cells of the previous one. Expand from M cells. Avoid X players and your own M cells. If "Previous plan" is given, continue it unless the board changed significantly.

RESPOND WITH ONLY THIS JSON, NO OTHER TEXT:
{"waypoints":[{"x":<int>,"y":<int>},{"x":<int>,"y":<int>},...],"strategy":"<plan description>"}
Give 5-8 waypoints that trace a path forming rectangles or enclosures. You have ~75 steps (15 seconds). Move ~${maxDist} cells per waypoint.`
}

interface StrategyResponse {
  waypoints: Array<{ x: number; y: number }>
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
  threats: string
  nearbyPlayers: Array<{
    name: string
    x: number
    y: number
    distance: number
    territory: number
  }>
}

// Cap ASCII map to keep LLM context manageable
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

  // Detect threats: find each opponent's territory bounding box and %
  const opponentRegions = new Map<
    string,
    {
      minX: number
      maxX: number
      minY: number
      maxY: number
      count: number
      name: string
    }
  >()
  cells.forEach((cell, key) => {
    if (cell.owner === myId) return
    let region = opponentRegions.get(cell.owner)
    if (!region) {
      const p = players.get(cell.owner)
      region = {
        minX: cols,
        maxX: 0,
        minY: rows,
        maxY: 0,
        count: 0,
        name: p?.name ?? `unknown`,
      }
      opponentRegions.set(cell.owner, region)
    }
    const [cx, cy] = key.split(`,`).map(Number)
    region.minX = Math.min(region.minX, cx)
    region.maxX = Math.max(region.maxX, cx)
    region.minY = Math.min(region.minY, cy)
    region.maxY = Math.max(region.maxY, cy)
    region.count++
  })

  const threatLines: Array<string> = []
  const sortedRegions = [...opponentRegions.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 3)
  for (const r of sortedRegions) {
    const pct = Math.round((r.count / totalCells) * 100)
    if (pct >= 3) {
      const w = r.maxX - r.minX
      const h = r.maxY - r.minY
      threatLines.push(
        `${r.name}: ${pct}% spanning (${r.minX},${r.minY})-(${r.maxX},${r.maxY}) ${w}x${h}`
      )
    }
  }
  const threats =
    threatLines.length > 0 ? threatLines.join(`\n`) : `No major threats`

  return {
    position: myPosition,
    myTerritory,
    rank,
    totalPlayers: players.size,
    timeRemainingSeconds: Math.max(0, Math.ceil(timeRemainingMs / 1000)),
    cols,
    rows,
    asciiMap,
    threats,
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

  lines.push(``)
  lines.push(`Opponent territories:`)
  lines.push(summary.threats)

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
    personality: AgentPersonality = `balanced`,
    lastStrategy?: string | null
  ): Promise<StrategyResponse> {
    let userMessage = formatSummary(summary)
    if (lastStrategy) {
      userMessage = `Previous plan: ${lastStrategy}\n\n${userMessage}`
    }
    const systemPrompt = buildSystemPrompt(
      summary.cols,
      summary.rows,
      personality
    )

    const tag = playerName ?? `Haiku`
    console.log(`[${tag}] Board sent to LLM:\n${userMessage}`)

    const response = await this.client.messages.create({
      model: `claude-haiku-4-5-20251001`,
      max_tokens: 500,
      system: systemPrompt,
      messages: [{ role: `user`, content: userMessage }],
    })

    const text =
      response.content[0].type === `text` ? response.content[0].text : ``
    console.log(`[${tag}] LLM response: ${text}`)

    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/)
      const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : text)

      // Support both waypoints format and legacy single-target
      let waypoints: Array<{ x: number; y: number }> = []
      if (Array.isArray(parsed.waypoints)) {
        waypoints = parsed.waypoints.filter(
          (w: any) =>
            typeof w.x === `number` &&
            typeof w.y === `number` &&
            w.x >= 0 &&
            w.x < summary.cols &&
            w.y >= 0 &&
            w.y < summary.rows
        )
      } else if (parsed.target?.x != null && parsed.target?.y != null) {
        waypoints = [parsed.target]
      }

      if (waypoints.length > 0) {
        const strategy =
          typeof parsed.strategy === `string` ? parsed.strategy : ``
        console.log(
          `[${tag}] Plan: ${waypoints.length} waypoints — ${strategy}`
        )
        return { waypoints, strategy }
      }
    } catch {
      // Fall through to fallback
    }

    return {
      waypoints: [
        {
          x: Math.floor(Math.random() * summary.cols),
          y: Math.floor(Math.random() * summary.rows),
        },
      ],
      strategy: `random fallback`,
    }
  }
}
