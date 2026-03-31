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
  getColor,
  getGameEndedAt,
  getGameStartedAt,
  getPlayersMap,
  hashName,
  initGameTimer,
  parseRoomConfig,
  readAllPlayers,
  readCells,
  readPlayers,
  setGameEnded,
} from "../utils/game-logic"
import { nextStep } from "./pathfinder"
import { buildBoardSummary } from "./haiku-client"
import type { HaikuClient } from "./haiku-client"

const STRATEGY_INTERVAL = 3000

export class AIPlayer {
  readonly playerId: string
  readonly playerName: string
  readonly playerColor: string

  private doc: Y.Doc
  private awareness: Awareness
  private provider: YjsProvider

  private x = 0
  private y = 0
  private stunnedUntil = 0
  private target: { x: number; y: number } | null = null

  private moveTimer: ReturnType<typeof setInterval> | null = null
  private strategyTimer: ReturnType<typeof setInterval> | null = null
  private timerCheckTimer: ReturnType<typeof setInterval> | null = null
  private destroyed = false

  private cols: number
  private rows: number
  private haiku: HaikuClient

  constructor(
    name: string,
    roomId: string,
    yjsBaseUrl: string,
    yjsHeaders: Record<string, string>,
    haikuClient: HaikuClient
  ) {
    this.playerName = `Bot-${name}`
    this.playerId = `bot-${name.toLowerCase()}-${Math.random().toString(36).slice(2, 8)}`
    this.playerColor = getColor(hashName(this.playerName))
    this.haiku = haikuClient

    const config = parseRoomConfig(roomId)
    this.cols = config.cols
    this.rows = config.rows

    this.doc = new Y.Doc()
    this.awareness = new Awareness(this.doc)
    this.awareness.setLocalState({
      user: { name: this.playerName, color: this.playerColor },
      playerId: this.playerId,
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

  private onSynced(): void {
    // Pick a start position spread across the board
    this.x = Math.floor(Math.random() * this.cols)
    this.y = Math.floor(Math.random() * this.rows)

    // Register in players map
    const playersMap = getPlayersMap(this.doc)
    playersMap.set(this.playerId, {
      x: this.x,
      y: this.y,
      name: this.playerName,
      color: this.playerColor,
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

    // Start loops
    this.moveTimer = setInterval(() => this.doMove(), MOVE_INTERVAL)
    this.strategyTimer = setInterval(
      () => void this.updateStrategy(),
      STRATEGY_INTERVAL
    )
    // Check timer expiry
    this.timerCheckTimer = setInterval(() => this.checkTimerExpiry(), 1000)

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

  private doMove(): void {
    if (this.destroyed) return
    if (getGameEndedAt(this.doc) !== null) return
    if (!this.target) return

    const others = readPlayers(this.doc, this.playerId)
    const dir = nextStep(
      { x: this.x, y: this.y },
      this.target,
      others,
      this.cols,
      this.rows
    )

    if (dir.dx === 0 && dir.dy === 0) return

    const result = executeMove(
      this.doc,
      this.playerId,
      this.playerName,
      this.playerColor,
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
      const cells = readCells(this.doc)
      const totalCells = this.cols * this.rows
      const playersMap = getPlayersMap(this.doc)
      const winner = findWinner(cells, totalCells, playersMap)
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

      const result = await this.haiku.getStrategy(summary)
      this.target = result.target

      console.log(
        `[${this.playerName}] Strategy: ${result.strategy} → (${result.target.x}, ${result.target.y})`
      )
    } catch (err) {
      console.error(`[${this.playerName}] Strategy error:`, err)
      // Keep current target or pick random
      if (!this.target) {
        this.target = {
          x: Math.floor(Math.random() * this.cols),
          y: Math.floor(Math.random() * this.rows),
        }
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
