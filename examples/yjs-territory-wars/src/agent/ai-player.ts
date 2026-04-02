import * as Y from "yjs"
import { Awareness } from "y-protocols/awareness"
import { YjsProvider } from "@durable-streams/y-durable-streams"
import {
  GAME_DURATION_MS,
  MOVE_INTERVAL,
  executeMove,
  findLeaderByScore,
  findWinner,
  getCellsMap,
  getGameEndedAt,
  getGameStartedAt,
  getPlayersMap,
  initGameTimer,
  parseRoomConfig,
  readAllPlayers,
  readCells,
  readPlayers,
  setGameEnded,
} from "../utils/game-logic"
import { nextStep } from "./pathfinder"
import { buildBoardSummary } from "./haiku-client"
import type { AgentPersonality, HaikuClient } from "./haiku-client"

const STRATEGY_INTERVAL = 15000

export class AIPlayer {
  readonly playerId: string
  readonly playerName: string
  playerColor: string

  private doc: Y.Doc
  private awareness: Awareness
  private provider: YjsProvider

  private x = 0
  private y = 0
  private stunnedUntil = 0
  private target: { x: number; y: number } | null = null
  private waypoints: Array<{ x: number; y: number }> = []

  private moveTimer: ReturnType<typeof setInterval> | null = null
  private strategyTimer: ReturnType<typeof setInterval> | null = null
  private timerCheckTimer: ReturnType<typeof setInterval> | null = null
  private destroyed = false
  private gameWasOver = false
  private lastStrategy: string | null = null

  private cols: number
  private rows: number
  private haiku: HaikuClient
  private personality: AgentPersonality
  private spawnCorner: number

  constructor(
    name: string,
    roomId: string,
    yjsBaseUrl: string,
    yjsHeaders: Record<string, string>,
    haikuClient: HaikuClient,
    color: string,
    personality: AgentPersonality = `balanced`,
    spawnCorner: number = 0
  ) {
    this.personality = personality
    this.spawnCorner = spawnCorner
    this.playerName = `Haiku-${name}`
    this.playerId = `bot-${name.toLowerCase()}-${Math.random().toString(36).slice(2, 8)}`
    this.playerColor = color
    this.haiku = haikuClient

    const config = parseRoomConfig(roomId)
    this.cols = config.cols
    this.rows = config.rows

    this.doc = new Y.Doc()
    this.awareness = new Awareness(this.doc)
    this.awareness.setLocalState({
      user: { name: this.playerName, color: this.playerColor },
      playerId: this.playerId,
      type: `bot`,
    })

    this.provider = new YjsProvider({
      doc: this.doc,
      baseUrl: yjsBaseUrl,
      docId: roomId,
      awareness: this.awareness,
      headers: yjsHeaders,
      connect: false,
    })

    this.provider.on(`synced`, (synced: boolean) => {
      if (synced && !this.destroyed) {
        this.onSynced()
      }
    })

    this.provider.connect()
  }

  private started = false

  private onSynced(): void {
    if (this.started) return
    this.started = true

    // Distribute spawn points across the board
    const spawn = this.getSpawnPosition()
    this.x = spawn.x
    this.y = spawn.y

    // Register in players map
    const playersMap = getPlayersMap(this.doc)
    playersMap.set(this.playerId, {
      x: this.x,
      y: this.y,
      name: this.playerName,
    })

    // Claim starting cell
    const cellsMap = getCellsMap(this.doc)
    this.doc.transact(() => {
      cellsMap.set(`${this.x},${this.y}`, {
        owner: this.playerId,
        claimedAt: Date.now(),
      })
    })

    // Init game timer
    initGameTimer(this.doc)

    // Start loops — stagger strategy calls so bots don't all hit the LLM at once
    const stagger = this.spawnCorner * 500
    this.moveTimer = setInterval(() => this.doMove(), MOVE_INTERVAL)
    setTimeout(() => {
      this.strategyTimer = setInterval(
        () => void this.updateStrategy(),
        STRATEGY_INTERVAL
      )
    }, stagger)
    // Check timer expiry and enclosure threats
    this.timerCheckTimer = setInterval(() => {
      this.checkTimerExpiry()
      this.checkEnclosureThreat()
    }, 1000)

    // Do an initial strategy call
    void this.updateStrategy()

    console.log(`[${this.playerName}] joined at (${this.x}, ${this.y})`)
  }

  private checkTimerExpiry(): void {
    if (getGameEndedAt(this.doc) !== null) return

    const startedAt = getGameStartedAt(this.doc)
    if (!startedAt) return

    const elapsed = Date.now() - startedAt
    if (elapsed >= GAME_DURATION_MS) {
      const cells = readCells(this.doc)
      const totalCells = this.cols * this.rows
      const playersMap = getPlayersMap(this.doc)

      // Check threshold first
      const thresholdWinner = findWinner(cells, totalCells, playersMap)
      if (thresholdWinner) {
        console.log(
          `[${this.playerName}] Game over: ${thresholdWinner.name} wins with ${thresholdWinner.pct}%`
        )
      } else {
        const leader = findLeaderByScore(cells, totalCells, playersMap)
        if (leader) {
          console.log(
            `[${this.playerName}] Time's up: ${leader.name} leads with ${leader.pct}%`
          )
        }
      }
      setGameEnded(this.doc)
    }
  }

  private checkEnclosureThreat(): void {
    if (this.destroyed) return
    if (getGameEndedAt(this.doc) !== null) return

    // Flood fill from current position through non-opponent cells
    // If reachable area is small, we're being enclosed — break out
    const cells = readCells(this.doc)
    const visited = new Set<string>()
    const queue: Array<{ x: number; y: number }> = [{ x: this.x, y: this.y }]
    visited.add(`${this.x},${this.y}`)

    const opponentBoundary: Array<{ x: number; y: number }> = []
    const maxCheck = 300
    let checked = 0
    let reachedEdge = false

    while (queue.length > 0 && checked < maxCheck) {
      const pos = queue.shift()!
      checked++

      // If we reached the board edge, we're not enclosed
      if (
        pos.x === 0 ||
        pos.x === this.cols - 1 ||
        pos.y === 0 ||
        pos.y === this.rows - 1
      ) {
        reachedEdge = true
      }

      for (const [dx, dy] of [
        [0, -1],
        [0, 1],
        [-1, 0],
        [1, 0],
      ]) {
        const nx = pos.x + dx
        const ny = pos.y + dy
        const key = `${nx},${ny}`

        if (nx < 0 || nx >= this.cols || ny < 0 || ny >= this.rows) continue
        if (visited.has(key)) continue
        visited.add(key)

        const cell = cells.get(key)
        if (cell && cell.owner !== this.playerId) {
          opponentBoundary.push({ x: nx, y: ny })
          continue // don't flood through opponent cells
        }

        queue.push({ x: nx, y: ny })
      }
    }

    // If flood fill completed (didn't hit maxCheck) and didn't reach edge,
    // we're being enclosed. Rush to break the nearest boundary cell.
    if (!reachedEdge && checked < maxCheck && opponentBoundary.length > 0) {
      let nearest = opponentBoundary[0]
      let minDist = Infinity
      for (const b of opponentBoundary) {
        const d = Math.abs(b.x - this.x) + Math.abs(b.y - this.y)
        if (d < minDist) {
          minDist = d
          nearest = b
        }
      }
      console.log(
        `[${this.playerName}] ENCLOSED! Breaking out toward (${nearest.x},${nearest.y}) dist=${minDist}`
      )
      this.target = nearest
    }
  }

  private resetForRematch(): void {
    console.log(`[${this.playerName}] Rematch detected — resetting`)
    this.gameWasOver = false
    this.stunnedUntil = 0
    this.target = null
    this.waypoints = []

    // Respawn at assigned position
    const spawn = this.getSpawnPosition()
    this.x = spawn.x
    this.y = spawn.y

    // Re-register in players map and claim starting cell
    const playersMap = getPlayersMap(this.doc)
    playersMap.set(this.playerId, {
      x: this.x,
      y: this.y,
      name: this.playerName,
    })
    const cellsMap = getCellsMap(this.doc)
    this.doc.transact(() => {
      cellsMap.set(`${this.x},${this.y}`, {
        owner: this.playerId,
        claimedAt: Date.now(),
      })
    })

    initGameTimer(this.doc)
    void this.updateStrategy()
  }

  private advanceWaypoint(): void {
    if (this.waypoints.length > 0) {
      this.target = this.clampTarget(this.waypoints.shift()!)
    } else {
      this.target = this.pickNearbyUnclaimedTarget()
    }
  }

  private getSpawnPosition(): { x: number; y: number } {
    const margin = Math.floor(Math.min(this.cols, this.rows) / 8)
    const jitter = () => Math.floor(Math.random() * margin)
    const cx = Math.floor(this.cols / 2)
    const cy = Math.floor(this.rows / 2)

    // 0-3: corners, 4+: distributed along edges and center
    const positions = [
      { x: jitter(), y: jitter() }, // 0: top-left
      { x: this.cols - 1 - jitter(), y: jitter() }, // 1: top-right
      { x: jitter(), y: this.rows - 1 - jitter() }, // 2: bottom-left
      { x: this.cols - 1 - jitter(), y: this.rows - 1 - jitter() }, // 3: bottom-right
      { x: cx + jitter(), y: cy + jitter() }, // 4: center
      { x: cx + jitter(), y: jitter() }, // 5: top-center
      { x: cx + jitter(), y: this.rows - 1 - jitter() }, // 6: bottom-center
    ]

    return positions[this.spawnCorner % positions.length]
  }

  private clampTarget(target: { x: number; y: number }): {
    x: number
    y: number
  } {
    // Destroyer gets more range to cross the map and break threats
    const baseDist = Math.floor(Math.min(this.cols, this.rows) / 5)
    const maxDist =
      this.personality === `destroyer`
        ? Math.max(12, baseDist * 2)
        : Math.max(6, baseDist)
    const dx = target.x - this.x
    const dy = target.y - this.y
    const dist = Math.abs(dx) + Math.abs(dy)
    if (dist <= maxDist) {
      console.log(
        `[${this.playerName}] Target: (${target.x},${target.y}) | pos: (${this.x},${this.y}) | dist: ${dist}`
      )
      return target
    }
    const ratio = maxDist / dist
    const clamped = {
      x: Math.max(0, Math.min(this.cols - 1, Math.round(this.x + dx * ratio))),
      y: Math.max(0, Math.min(this.rows - 1, Math.round(this.y + dy * ratio))),
    }
    console.log(
      `[${this.playerName}] Clamped: (${target.x},${target.y})→(${clamped.x},${clamped.y}) | pos: (${this.x},${this.y}) | ${dist}→${maxDist}`
    )
    return clamped
  }

  private pickNearbyUnclaimedTarget(): { x: number; y: number } {
    const cells = readCells(this.doc)
    const range = 8
    const candidates: Array<{ x: number; y: number }> = []
    for (let dy = -range; dy <= range; dy++) {
      for (let dx = -range; dx <= range; dx++) {
        const x = this.x + dx
        const y = this.y + dy
        if (x < 0 || x >= this.cols || y < 0 || y >= this.rows) continue
        const cell = cells.get(`${x},${y}`)
        if (!cell || cell.owner !== this.playerId) {
          candidates.push({ x, y })
        }
      }
    }
    if (candidates.length > 0) {
      return candidates[Math.floor(Math.random() * candidates.length)]
    }
    // Fallback: random position
    return {
      x: Math.floor(Math.random() * this.cols),
      y: Math.floor(Math.random() * this.rows),
    }
  }

  private doMove(): void {
    if (this.destroyed) return
    const gameEnded = getGameEndedAt(this.doc) !== null
    if (gameEnded) {
      this.gameWasOver = true
      return
    }
    if (this.gameWasOver) {
      this.resetForRematch()
      return
    }
    if (!this.target) {
      this.advanceWaypoint()
    }
    if (!this.target) return

    const others = readPlayers(this.doc, this.playerId)
    const cells = readCells(this.doc)
    const dir = nextStep(
      { x: this.x, y: this.y },
      this.target,
      others,
      this.cols,
      this.rows,
      cells,
      this.playerId
    )

    if (dir.dx === 0 && dir.dy === 0) {
      // Reached target — advance to next waypoint or pick random
      this.advanceWaypoint()
      return
    }

    const result = executeMove(
      this.doc,
      this.playerId,
      this.playerName,
      { x: this.x, y: this.y },
      dir,
      this.cols,
      this.rows,
      this.stunnedUntil
    )

    this.stunnedUntil = result.stunnedUntil
    if (result.moved) {
      this.x = result.x
      this.y = result.y

      this.awareness.setLocalState({
        ...this.awareness.getLocalState(),
        x: result.x,
        y: result.y,
      })
    }

    // Check win condition
    if (getGameEndedAt(this.doc) === null) {
      const currentCells = readCells(this.doc)
      const totalCells = this.cols * this.rows
      const playersMap = getPlayersMap(this.doc)
      const winner = findWinner(currentCells, totalCells, playersMap)
      if (winner) {
        console.log(
          `[${this.playerName}] ${winner.name} wins with ${winner.pct}%!`
        )
        setGameEnded(this.doc)
      }
    }
  }

  private async updateStrategy(): Promise<void> {
    if (this.destroyed) return
    if (getGameEndedAt(this.doc) !== null) return

    try {
      const cells = readCells(this.doc)
      const allPlayers = readAllPlayers(this.doc)
      const startedAt = getGameStartedAt(this.doc)
      const timeRemainingMs = startedAt
        ? Math.max(0, GAME_DURATION_MS - (Date.now() - startedAt))
        : GAME_DURATION_MS

      const summary = buildBoardSummary(
        { x: this.x, y: this.y },
        this.playerId,
        cells,
        allPlayers,
        this.cols,
        this.rows,
        timeRemainingMs
      )

      const result = await this.haiku.getStrategy(
        summary,
        this.playerName,
        this.personality,
        this.lastStrategy
      )
      this.waypoints = result.waypoints.slice(1) // rest after first
      this.target = this.clampTarget(
        result.waypoints[0] ?? this.pickNearbyUnclaimedTarget()
      )
      this.lastStrategy = result.strategy
    } catch (err) {
      console.error(`[${this.playerName}] Strategy error:`, err)
      if (!this.target) {
        this.target = this.pickNearbyUnclaimedTarget()
      }
    }
  }

  destroy(): void {
    this.destroyed = true

    if (this.moveTimer) clearInterval(this.moveTimer)
    if (this.strategyTimer) clearInterval(this.strategyTimer)
    if (this.timerCheckTimer) clearInterval(this.timerCheckTimer)

    // Remove from players map
    try {
      const playersMap = getPlayersMap(this.doc)
      playersMap.delete(this.playerId)
    } catch {
      // doc may already be destroyed
    }

    this.provider.destroy()
    this.doc.destroy()

    console.log(`[${this.playerName}] destroyed`)
  }
}
