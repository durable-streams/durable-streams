import { Hono } from "hono"
import { cors } from "hono/cors"
import { streamRoutes } from "./routes/stream"
import { teamRoutes } from "./routes/team"
import { drawRoutes } from "./routes/draw"
import { GameWriterDO } from "./do/game-writer"

export { GameWriterDO }

export type Bindings = {
  ASSETS: Fetcher
  GAME_WRITER?: DurableObjectNamespace // Optional - not available in local dev
  DURABLE_STREAMS_URL: string
  TEAM_COOKIE_SECRET?: string
  DRAW_RATE_LIMITER?: RateLimit
  NODE_ENV?: string
}

const app = new Hono<{ Bindings: Bindings }>()

// CORS for development
app.use(`/api/*`, cors())

// API routes
app.route(`/api/stream`, streamRoutes)
app.route(`/api/team`, teamRoutes)
app.route(`/api/draw`, drawRoutes)

// Serve static assets for everything else
app.all(`*`, async (c) => {
  return c.env.ASSETS.fetch(c.req.raw)
})

export default app
