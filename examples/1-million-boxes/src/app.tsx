import { useEffect, useState } from "react"
import { TeamProvider } from "./contexts/team-context"
import { QuotaProvider } from "./contexts/quota-context"
import { GameStateProvider } from "./contexts/game-state-context"
import { GamePage } from "./components/GamePage"
import { DebugOverlay } from "./components/ui/DebugOverlay"
import type { TeamName } from "./lib/teams"
import "./styles/global.css"

export function App() {
  const [teamData, setTeamData] = useState<{
    team: TeamName
    teamId: number
  } | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let mounted = true

    async function loadTeam() {
      try {
        const response = await fetch(`/api/team`)
        const data = await response.json()
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
            <GamePage />
            <DebugOverlay />
          </div>
        </GameStateProvider>
      </QuotaProvider>
    </TeamProvider>
  )
}
