# Phase 04: Frontend Foundation

## Goal

Set up the React frontend structure: routing, layout components, CSS architecture, and context providers for team and quota.

## Dependencies

- Phase 01 (Project Setup)

## Tasks

### 4.1 Root Route with Providers

Create `src/routes/__root.tsx`:

```tsx
import { createRootRoute, Outlet } from "@tanstack/react-router"
import { getTeam } from "../server/functions"
import "../styles/global.css"

export const Route = createRootRoute({
  loader: async () => {
    const { team, teamId } = await getTeam()
    return { team, teamId }
  },
  component: RootComponent,
})

function RootComponent() {
  const { team, teamId } = Route.useLoaderData()

  return (
    <TeamProvider team={team} teamId={teamId}>
      <QuotaProvider>
        <div className="app-container">
          <Outlet />
        </div>
      </QuotaProvider>
    </TeamProvider>
  )
}
```

### 4.2 Team Context

Create `src/contexts/team-context.tsx`:

```tsx
import { createContext, useContext, ReactNode } from "react"
import { TeamName } from "../lib/teams"

interface TeamContextValue {
  team: TeamName
  teamId: number
}

const TeamContext = createContext<TeamContextValue | null>(null)

export function TeamProvider({
  children,
  team,
  teamId,
}: {
  children: ReactNode
  team: TeamName
  teamId: number
}) {
  return (
    <TeamContext.Provider value={{ team, teamId }}>
      {children}
    </TeamContext.Provider>
  )
}

export function useTeam(): TeamContextValue {
  const ctx = useContext(TeamContext)
  if (!ctx) {
    throw new Error("useTeam must be used within TeamProvider")
  }
  return ctx
}
```

### 4.3 Quota Context and Hook

Create `src/contexts/quota-context.tsx`:

```tsx
import {
  createContext,
  useContext,
  ReactNode,
  useState,
  useEffect,
  useCallback,
} from "react"

const QUOTA_KEY = "boxes:quota"
const MAX_QUOTA = 8
const REFILL_INTERVAL_MS = 7500 // 7.5 seconds

interface QuotaState {
  remaining: number
  lastRefillAt: number
  version: number
}

interface QuotaContextValue {
  remaining: number
  max: number
  refillIn: number
  consume: () => boolean
  refund: () => void
}

const QuotaContext = createContext<QuotaContextValue | null>(null)

function loadQuota(): QuotaState {
  try {
    const stored = localStorage.getItem(QUOTA_KEY)
    if (stored) {
      const state = JSON.parse(stored) as QuotaState

      // Calculate refills since last visit
      const now = Date.now()
      const elapsed = now - state.lastRefillAt
      const refills = Math.floor(elapsed / REFILL_INTERVAL_MS)

      if (refills > 0) {
        state.remaining = Math.min(MAX_QUOTA, state.remaining + refills)
        state.lastRefillAt += refills * REFILL_INTERVAL_MS
      }

      return state
    }
  } catch {
    // Ignore parse errors
  }

  return {
    remaining: MAX_QUOTA,
    lastRefillAt: Date.now(),
    version: 1,
  }
}

function saveQuota(state: QuotaState): void {
  localStorage.setItem(QUOTA_KEY, JSON.stringify(state))
}

export function QuotaProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<QuotaState>(() => loadQuota())
  const [refillIn, setRefillIn] = useState(0)

  // Persist to localStorage
  useEffect(() => {
    saveQuota(state)
  }, [state])

  // Refill timer
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now()
      const elapsed = now - state.lastRefillAt
      const refills = Math.floor(elapsed / REFILL_INTERVAL_MS)

      if (refills > 0 && state.remaining < MAX_QUOTA) {
        setState((s) => ({
          ...s,
          remaining: Math.min(MAX_QUOTA, s.remaining + refills),
          lastRefillAt: s.lastRefillAt + refills * REFILL_INTERVAL_MS,
        }))
      }

      // Calculate time until next refill
      const timeSinceLastRefill = now - state.lastRefillAt
      const timeUntilNext = Math.max(
        0,
        REFILL_INTERVAL_MS - timeSinceLastRefill
      )
      setRefillIn(Math.ceil(timeUntilNext / 1000))
    }, 1000)

    return () => clearInterval(interval)
  }, [state.lastRefillAt, state.remaining])

  // Cross-tab sync
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key === QUOTA_KEY && e.newValue) {
        setState(JSON.parse(e.newValue))
      }
    }

    window.addEventListener("storage", handler)
    return () => window.removeEventListener("storage", handler)
  }, [])

  const consume = useCallback(() => {
    if (state.remaining <= 0) return false

    setState((s) => ({
      ...s,
      remaining: s.remaining - 1,
    }))

    return true
  }, [state.remaining])

  const refund = useCallback(() => {
    setState((s) => ({
      ...s,
      remaining: Math.min(MAX_QUOTA, s.remaining + 1),
    }))
  }, [])

  return (
    <QuotaContext.Provider
      value={{
        remaining: state.remaining,
        max: MAX_QUOTA,
        refillIn,
        consume,
        refund,
      }}
    >
      {children}
    </QuotaContext.Provider>
  )
}

export function useQuota(): QuotaContextValue {
  const ctx = useContext(QuotaContext)
  if (!ctx) {
    throw new Error("useQuota must be used within QuotaProvider")
  }
  return ctx
}
```

### 4.4 Main Game Route

Create `src/routes/index.tsx`:

```tsx
import { createFileRoute } from "@tanstack/react-router"
import { Header } from "../components/layout/Header"
import { Footer } from "../components/layout/Footer"
import { GameCanvas } from "../components/game/GameCanvas"
import { WorldView } from "../components/game/WorldView"
import "../styles/game.css"

export const Route = createFileRoute("/")({
  component: GamePage,
})

function GamePage() {
  return (
    <div className="game-layout">
      <Header />
      <main className="game-main">
        <GameCanvas />
        <WorldView />
      </main>
      <Footer />
    </div>
  )
}
```

### 4.5 Layout Components

Create `src/components/layout/Header.tsx`:

```tsx
import { useTeam } from "../../contexts/team-context"
import { TeamBadge } from "../ui/TeamBadge"
import { ScoreBoard } from "../ui/ScoreBoard"
import "./Header.css"

export function Header() {
  const { team, teamId } = useTeam()

  return (
    <header className="header" data-testid="header">
      <TeamBadge team={team} teamId={teamId} />
      <ScoreBoard />
    </header>
  )
}
```

Create `src/components/layout/Footer.tsx`:

```tsx
import { useQuota } from "../../contexts/quota-context"
import { QuotaMeter } from "../ui/QuotaMeter"
import { ZoomControls } from "../ui/ZoomControls"
import "./Footer.css"

export function Footer() {
  const { remaining, max, refillIn } = useQuota()

  return (
    <footer className="footer" data-testid="footer">
      <QuotaMeter remaining={remaining} max={max} refillIn={refillIn} />
      <ZoomControls />
    </footer>
  )
}
```

### 4.6 CSS Files

Create `src/styles/game.css`:

```css
.game-layout {
  display: flex;
  flex-direction: column;
  height: 100vh;
  height: 100dvh; /* Dynamic viewport height for mobile */
  overflow: hidden;
}

.game-main {
  flex: 1;
  position: relative;
  overflow: hidden;
}
```

Create `src/components/layout/Header.css`:

```css
.header {
  height: var(--header-height);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px;
  background: rgba(255, 255, 255, 0.9);
  border-bottom: 1px solid var(--color-border);
  z-index: 10;
}
```

Create `src/components/layout/Footer.css`:

```css
.footer {
  height: var(--footer-height);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px;
  background: rgba(255, 255, 255, 0.9);
  border-top: 1px solid var(--color-border);
  z-index: 10;
}
```

### 4.7 Placeholder Components

Create placeholder components that will be implemented in later phases:

Create `src/components/game/GameCanvas.tsx`:

```tsx
export function GameCanvas() {
  return (
    <canvas
      className="game-canvas"
      data-testid="game-canvas"
      style={{ width: "100%", height: "100%" }}
    />
  )
}
```

Create `src/components/game/WorldView.tsx`:

```tsx
export function WorldView() {
  return (
    <div
      className="world-view"
      data-testid="world-view"
      style={{
        position: "absolute",
        bottom: "var(--minimap-margin)",
        right: "var(--minimap-margin)",
        width: "var(--minimap-size)",
        height: "var(--minimap-size)",
        background: "rgba(0,0,0,0.7)",
        borderRadius: "8px",
        border: "2px solid white",
      }}
    />
  )
}
```

Create `src/components/ui/TeamBadge.tsx`:

```tsx
import { TeamName, TEAM_COLORS } from "../../lib/teams"

interface TeamBadgeProps {
  team: TeamName
  teamId: number
}

export function TeamBadge({ team, teamId }: TeamBadgeProps) {
  const color = TEAM_COLORS[team].primary

  return (
    <div
      className="team-badge"
      data-testid="team-badge"
      style={{
        display: "flex",
        alignItems: "center",
        gap: "8px",
      }}
    >
      <div
        style={{
          width: 16,
          height: 16,
          borderRadius: "50%",
          background: color,
        }}
      />
      <span>{team}</span>
    </div>
  )
}
```

Create `src/components/ui/ScoreBoard.tsx`:

```tsx
export function ScoreBoard() {
  // TODO: Get scores from game state
  const scores = [0, 0, 0, 0]

  return (
    <div className="scoreboard" data-testid="scoreboard">
      <span data-testid="score-red">R: {scores[0]}</span>
      <span data-testid="score-blue">B: {scores[1]}</span>
      <span data-testid="score-green">G: {scores[2]}</span>
      <span data-testid="score-yellow">Y: {scores[3]}</span>
    </div>
  )
}
```

Create `src/components/ui/QuotaMeter.tsx`:

```tsx
import * as Progress from "@base-ui/react/progress"
import "./QuotaMeter.css"

interface QuotaMeterProps {
  remaining: number
  max: number
  refillIn: number
}

export function QuotaMeter({ remaining, max, refillIn }: QuotaMeterProps) {
  const color = remaining > 5 ? "full" : remaining > 2 ? "mid" : "low"

  return (
    <div className="quota-meter" data-testid="quota-meter">
      <Progress.Root value={remaining} max={max} className="quota-progress">
        <Progress.Track className="quota-track">
          <Progress.Indicator className={`quota-indicator quota-${color}`} />
        </Progress.Track>
      </Progress.Root>
      <span className="quota-text">
        {remaining}/{max} lines
      </span>
      {remaining < max && (
        <span className="quota-refill">+1 in {refillIn}s</span>
      )}
    </div>
  )
}
```

Create `src/components/ui/ZoomControls.tsx`:

```tsx
export function ZoomControls() {
  // TODO: Connect to view state
  return (
    <div className="zoom-controls">
      <button data-testid="zoom-out" aria-label="Zoom out">
        −
      </button>
      <button data-testid="zoom-in" aria-label="Zoom in">
        +
      </button>
    </div>
  )
}
```

### 4.8 CSS for UI Components

Create `src/components/ui/QuotaMeter.css`:

```css
.quota-meter {
  display: flex;
  align-items: center;
  gap: 8px;
}

.quota-progress {
  width: 100px;
}

.quota-track {
  height: 8px;
  background: #ddd;
  border-radius: 4px;
  overflow: hidden;
}

.quota-indicator {
  height: 100%;
  transition: width 0.2s;
}

.quota-full {
  background: var(--quota-full);
}

.quota-mid {
  background: var(--quota-mid);
}

.quota-low {
  background: var(--quota-low);
}

.quota-text {
  font-size: 14px;
  font-weight: 500;
}

.quota-refill {
  font-size: 12px;
  color: #666;
}
```

## Deliverables

- [ ] `src/routes/__root.tsx` — Root route with providers
- [ ] `src/routes/index.tsx` — Main game page
- [ ] `src/contexts/team-context.tsx` — Team context
- [ ] `src/contexts/quota-context.tsx` — Quota context with localStorage
- [ ] `src/components/layout/Header.tsx` — Header component
- [ ] `src/components/layout/Footer.tsx` — Footer component
- [ ] Placeholder game components
- [ ] Placeholder UI components
- [ ] CSS for layout and components
- [ ] App renders with team badge and quota meter

## Next Phase

→ `05-canvas-rendering.md`
