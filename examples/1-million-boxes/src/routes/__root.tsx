import { Outlet, createRootRoute } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { TeamProvider } from "../contexts/team-context"
import { QuotaProvider } from "../contexts/quota-context"
import { GameStateProvider } from "../contexts/game-state-context"
import { getTeam } from "../server/functions"
import type { TeamName } from "../lib/teams"
import "../styles/global.css"

export const Route = createRootRoute({
  component: RootComponent,
  ssr: false, // Client-only rendering
})

function RootComponent() {
  const [teamData, setTeamData] = useState<{
    team: TeamName
    teamId: number
  } | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let mounted = true

    async function loadTeam() {
      try {
        const data = await getTeam()
        if (mounted) {
          setTeamData(data)
          setLoading(false)
        }
      } catch (err) {
        console.error(`Failed to load team:`, err)
        // Fallback to a default team
        if (mounted) {
          setTeamData({ team: `RED`, teamId: 0 })
          setLoading(false)
        }
      }
    }

    loadTeam()

    return () => {
      mounted = false
    }
  }, [])

  if (loading) {
    return (
      <div className="app-loading">
        <div className="app-loading-spinner" />
      </div>
    )
  }

  const { team, teamId } = teamData!

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
