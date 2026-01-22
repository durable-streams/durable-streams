import { Outlet, createRootRoute } from "@tanstack/react-router"
import { TeamProvider } from "../contexts/team-context"
import { QuotaProvider } from "../contexts/quota-context"
import { GameStateProvider } from "../contexts/game-state-context"
import "../styles/global.css"

export const Route = createRootRoute({
  component: RootComponent,
})

function RootComponent() {
  // Placeholder team data - will be connected to server later
  const team = `RED` as const
  const teamId = 0

  return (
    <TeamProvider team={team} teamId={teamId}>
      <QuotaProvider>
        <GameStateProvider>
          <div className="app-container" data-testid="app-container">
            <Outlet />
          </div>
        </GameStateProvider>
      </QuotaProvider>
    </TeamProvider>
  )
}
