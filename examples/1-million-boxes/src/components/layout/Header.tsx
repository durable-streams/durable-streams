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
