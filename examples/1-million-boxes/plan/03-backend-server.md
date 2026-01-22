# Phase 03: Backend Server

## Goal

Implement the server-side components: GameWriterDO (Durable Object), team allocation with signed cookies, and the draw API endpoint.

## Dependencies

- Phase 01 (Project Setup)
- Phase 02 (Core Game Logic)

## Tasks

### 3.1 Team Cookie Utilities

Create `src/server/team-cookie.ts`:

```typescript
import { TEAMS, TeamName } from "../lib/teams"

const COOKIE_NAME = "boxes_team"

// Create HMAC signature (using Web Crypto API)
async function sign(data: string, secret: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )

  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(data))
  const hex = Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")

  return hex.slice(0, 32) // Truncate to 32 chars
}

// Verify HMAC signature with timing-safe comparison
async function verify(
  data: string,
  signature: string,
  secret: string
): Promise<boolean> {
  const expected = await sign(data, secret)

  if (signature.length !== expected.length) return false

  let result = 0
  for (let i = 0; i < signature.length; i++) {
    result |= signature.charCodeAt(i) ^ expected.charCodeAt(i)
  }

  return result === 0
}

// Parse and verify team cookie
export async function parseTeamCookie(
  cookieHeader: string | null,
  secret: string
): Promise<number | null> {
  if (!cookieHeader) return null

  // Find our cookie
  const cookies = cookieHeader.split(";").map((c) => c.trim())
  const ourCookie = cookies.find((c) => c.startsWith(`${COOKIE_NAME}=`))

  if (!ourCookie) return null

  const value = ourCookie.slice(COOKIE_NAME.length + 1)
  const [teamIdStr, sig] = value.split(".")

  if (!teamIdStr || !sig) return null

  const teamId = parseInt(teamIdStr, 10)
  if (isNaN(teamId) || teamId < 0 || teamId > 3) return null

  const valid = await verify(teamIdStr, sig, secret)
  if (!valid) return null

  return teamId
}

// Create signed team cookie value
export async function createTeamCookie(
  teamId: number,
  secret: string
): Promise<string> {
  const sig = await sign(String(teamId), secret)
  return `${teamId}.${sig}`
}

// Build Set-Cookie header
export function buildSetCookieHeader(
  cookieValue: string,
  isProduction: boolean
): string {
  const parts = [
    `${COOKIE_NAME}=${cookieValue}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=31536000", // 1 year
  ]

  if (isProduction) {
    parts.push("Secure")
  }

  return parts.join("; ")
}
```

### 3.2 Team Assignment Logic

Create `src/server/team-assignment.ts`:

```typescript
// Simple random team assignment with optional balancing
// For v1, we just pick randomly. Future: use KV counter for balancing.

export function assignTeam(): number {
  return Math.floor(Math.random() * 4)
}

// Future: balanced assignment
// export async function assignTeamBalanced(kv: KVNamespace): Promise<number> {
//   const counts = await Promise.all([
//     kv.get('team:0:count').then(v => parseInt(v || '0')),
//     kv.get('team:1:count').then(v => parseInt(v || '0')),
//     kv.get('team:2:count').then(v => parseInt(v || '0')),
//     kv.get('team:3:count').then(v => parseInt(v || '0')),
//   ]);
//
//   const minCount = Math.min(...counts);
//   const candidates = counts
//     .map((c, i) => (c === minCount ? i : -1))
//     .filter(i => i !== -1);
//
//   const teamId = candidates[Math.floor(Math.random() * candidates.length)];
//   await kv.put(`team:${teamId}:count`, String(counts[teamId] + 1));
//
//   return teamId;
// }
```

### 3.3 GameWriterDO (Durable Object)

Create `src/server/game-writer-do.ts`:

```typescript
import { GameState, GameEvent } from "../lib/game-state"
import { parseStreamRecords, encodeEvent } from "../lib/stream-parser"
import { EDGE_COUNT, isValidEdgeId } from "../lib/edge-math"

interface Env {
  DURABLE_STREAMS_URL: string
}

export class GameWriterDO {
  private state: DurableObjectState
  private env: Env

  // In-memory state
  private gameState: GameState | null = null
  private ready = false
  private initPromise: Promise<void> | null = null

  constructor(state: DurableObjectState, env: Env) {
    this.state = state
    this.env = env
  }

  // Lazy initialization
  private async ensureReady(): Promise<void> {
    if (this.ready) return

    if (!this.initPromise) {
      this.initPromise = this.initialize()
    }

    await this.initPromise
  }

  // Initialize by replaying the stream
  private async initialize(): Promise<void> {
    this.gameState = new GameState()

    try {
      // Fetch entire stream from Durable Streams server
      const response = await fetch(
        `${this.env.DURABLE_STREAMS_URL}/streams/boxes/edges`
      )

      if (response.ok) {
        const bytes = new Uint8Array(await response.arrayBuffer())
        const events = parseStreamRecords(bytes)

        for (const event of events) {
          this.gameState.applyEvent(event)
        }

        console.log(
          `GameWriterDO initialized: ${this.gameState.getEdgesPlacedCount()} edges`
        )
      }
    } catch (err) {
      console.error("Failed to fetch stream during init:", err)
      // Continue with empty state - stream might not exist yet
    }

    this.ready = true
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === "/draw" && request.method === "POST") {
      return this.handleDraw(request)
    }

    return new Response("Not found", { status: 404 })
  }

  private async handleDraw(request: Request): Promise<Response> {
    // Ensure we're initialized
    if (!this.ready) {
      try {
        await this.ensureReady()
      } catch {
        return Response.json({ ok: false, code: "WARMING_UP" }, { status: 503 })
      }
    }

    // Parse request
    let body: { edgeId: number; teamId: number }
    try {
      body = await request.json()
    } catch {
      return Response.json(
        { ok: false, code: "INVALID_REQUEST" },
        { status: 400 }
      )
    }

    const { edgeId, teamId } = body

    // Validate edge ID
    if (!isValidEdgeId(edgeId)) {
      return Response.json({ ok: false, code: "INVALID_EDGE" }, { status: 400 })
    }

    // Validate team ID
    if (typeof teamId !== "number" || teamId < 0 || teamId > 3) {
      return Response.json({ ok: false, code: "INVALID_TEAM" }, { status: 400 })
    }

    // Check if game is complete
    if (this.gameState!.isComplete()) {
      return Response.json(
        { ok: false, code: "GAME_COMPLETE" },
        { status: 410 }
      )
    }

    // Check if edge is already taken
    if (this.gameState!.isEdgeTaken(edgeId)) {
      return Response.json({ ok: false, code: "EDGE_TAKEN" }, { status: 409 })
    }

    // Append to Durable Stream
    const event: GameEvent = { edgeId, teamId }
    const encoded = encodeEvent(event)

    try {
      const appendResponse = await fetch(
        `${this.env.DURABLE_STREAMS_URL}/streams/boxes/edges/append`,
        {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: encoded,
        }
      )

      if (!appendResponse.ok) {
        throw new Error(`Append failed: ${appendResponse.status}`)
      }
    } catch (err) {
      console.error("Failed to append to stream:", err)
      return Response.json({ ok: false, code: "STREAM_ERROR" }, { status: 500 })
    }

    // Update local state
    this.gameState!.applyEvent(event)

    return Response.json({ ok: true })
  }
}
```

### 3.4 Server Functions

Create `src/server/functions.ts`:

```typescript
import { createServerFn } from "@tanstack/react-start"
import { z } from "zod"
import {
  parseTeamCookie,
  createTeamCookie,
  buildSetCookieHeader,
} from "./team-cookie"
import { assignTeam } from "./team-assignment"
import { teamIdToName } from "../lib/teams"

// Get or assign team
export const getTeam = createServerFn({ method: "GET" }).handler(
  async ({ request }) => {
    const secret = process.env.TEAM_COOKIE_SECRET || "dev-secret"
    const isProduction = process.env.NODE_ENV === "production"

    const cookieHeader = request.headers.get("cookie")
    let teamId = await parseTeamCookie(cookieHeader, secret)

    const headers = new Headers()

    if (teamId === null) {
      // Assign new team
      teamId = assignTeam()
      const cookieValue = await createTeamCookie(teamId, secret)
      headers.set("Set-Cookie", buildSetCookieHeader(cookieValue, isProduction))
    }

    return {
      team: teamIdToName(teamId),
      teamId,
      headers,
    }
  }
)

// Draw an edge
export const drawEdge = createServerFn({ method: "POST" })
  .validator(z.object({ edgeId: z.number().int().min(0) }))
  .handler(async ({ data, request, context }) => {
    const secret = process.env.TEAM_COOKIE_SECRET || "dev-secret"
    const cookieHeader = request.headers.get("cookie")

    const teamId = await parseTeamCookie(cookieHeader, secret)

    if (teamId === null) {
      return { ok: false, code: "NO_TEAM" }
    }

    // Get DO binding from context (Cloudflare Workers)
    const env = context.cloudflare?.env
    if (!env?.GAME_WRITER) {
      return { ok: false, code: "NO_DO" }
    }

    // Get DO stub
    const id = env.GAME_WRITER.idFromName("game")
    const stub = env.GAME_WRITER.get(id)

    // Forward to DO
    const response = await stub.fetch("http://do/draw", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ edgeId: data.edgeId, teamId }),
    })

    return response.json()
  })
```

### 3.5 Export DO Class

Update `src/server/index.ts`:

```typescript
export { GameWriterDO } from "./game-writer-do"
```

Update `wrangler.jsonc` to reference the DO class:

```jsonc
{
  "durable_objects": {
    "bindings": [
      {
        "name": "GAME_WRITER",
        "class_name": "GameWriterDO",
        "script_name": "1-million-boxes",
      },
    ],
  },
  "migrations": [
    {
      "tag": "v1",
      "new_classes": ["GameWriterDO"],
    },
  ],
}
```

### 3.6 Integration Test

Create `tests/integration/do-validation.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { unstable_dev } from "wrangler"

describe("GameWriterDO", () => {
  let worker

  beforeAll(async () => {
    worker = await unstable_dev("src/server/game-writer-do.ts", {
      experimental: { disableExperimentalWarning: true },
    })
  })

  afterAll(async () => {
    await worker?.stop()
  })

  it("accepts valid edge placement", async () => {
    const res = await worker.fetch("/draw", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ edgeId: 12345, teamId: 0 }),
    })

    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.ok).toBe(true)
  })

  it("rejects duplicate edge", async () => {
    // First placement
    await worker.fetch("/draw", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ edgeId: 99999, teamId: 0 }),
    })

    // Second placement of same edge
    const res = await worker.fetch("/draw", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ edgeId: 99999, teamId: 1 }),
    })

    expect(res.status).toBe(409)
    const data = await res.json()
    expect(data.code).toBe("EDGE_TAKEN")
  })
})
```

## Deliverables

- [ ] `src/server/team-cookie.ts` — Cookie signing/verification
- [ ] `src/server/team-assignment.ts` — Team assignment logic
- [ ] `src/server/game-writer-do.ts` — GameWriterDO class
- [ ] `src/server/functions.ts` — TanStack Start server functions
- [ ] Wrangler configured with DO bindings
- [ ] Integration tests passing

## Next Phase

→ `04-frontend-foundation.md`
