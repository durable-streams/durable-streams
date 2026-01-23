import { useState } from "react"
import { useGameStateContext } from "../../contexts/game-state-context"
import { TEAMS, TEAM_COLORS } from "../../lib/teams"
import { FIRST_TO_SCORE_TARGET, GAME_END_MODE } from "../../lib/config"
import "./GameCompleteDialog.css"

export function GameCompleteDialog() {
  const { isGameComplete, winner, gameState } = useGameStateContext()
  const [dismissed, setDismissed] = useState(false)

  if (!isGameComplete || dismissed) {
    return null
  }

  const scores = gameState.getScores()
  const winnerName = winner !== null ? TEAMS[winner] : null
  const winnerColor = winnerName ? TEAM_COLORS[winnerName].primary : `#888`

  // Sort teams by score for display
  const teamScores = TEAMS.map((team, i) => ({
    team,
    score: scores[i],
    color: TEAM_COLORS[team].primary,
  })).sort((a, b) => b.score - a.score)

  const endModeText =
    GAME_END_MODE === `first_to_score`
      ? `First to ${FIRST_TO_SCORE_TARGET} boxes`
      : `All boxes claimed`

  return (
    <div className="game-complete-backdrop">
      <div className="game-complete-dialog">
        <h2 className="game-complete-title">Game Complete!</h2>

        <div className="game-complete-mode">{endModeText}</div>

        {winnerName ? (
          <div className="game-complete-winner">
            <div
              className="game-complete-winner-dot"
              style={{ backgroundColor: winnerColor }}
            />
            <span className="game-complete-winner-name">
              {winnerName.charAt(0) + winnerName.slice(1).toLowerCase()} Team
              Wins!
            </span>
          </div>
        ) : (
          <div className="game-complete-tie">It&apos;s a Tie!</div>
        )}

        <div className="game-complete-scores">
          <h3>Final Scores</h3>
          <div className="game-complete-score-list">
            {teamScores.map(({ team, score, color }) => (
              <div key={team} className="game-complete-score-item">
                <span
                  className="game-complete-score-dot"
                  style={{ backgroundColor: color }}
                />
                <span className="game-complete-score-name">
                  {team.charAt(0) + team.slice(1).toLowerCase()}
                </span>
                <span className="game-complete-score-value">
                  {score.toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        </div>

        <button
          className="game-complete-button"
          onClick={() => setDismissed(true)}
        >
          View Game Board
        </button>
      </div>
    </div>
  )
}
