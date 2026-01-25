import { useEffect, useRef, useState } from "react"
import { TEAMS, TEAM_COLORS } from "../../lib/teams"
import { useQuota } from "../../contexts/quota-context"
import type { TeamName } from "../../lib/teams"
import "./ScoreBoard.css"

export interface ScoreBoardProps {
  scores?: [number, number, number, number]
  className?: string
}

interface TeamScore {
  team: TeamName
  score: number
  color: string
}

/** Animated score value that glows when it changes */
function AnimatedScore({
  value,
  color,
  className = ``,
}: {
  value: number
  color?: string
  className?: string
}) {
  const [glowKey, setGlowKey] = useState(0)
  const prevValueRef = useRef(value)
  const isFirstRender = useRef(true)

  useEffect(() => {
    // Skip animation on first render
    if (isFirstRender.current) {
      isFirstRender.current = false
      prevValueRef.current = value
      return
    }

    // Trigger glow when value changes by incrementing key
    if (value !== prevValueRef.current) {
      prevValueRef.current = value
      setGlowKey((k) => k + 1)
    }
  }, [value])

  const formattedValue = value.toLocaleString()

  return (
    <span
      className={`scoreboard-value ${className}`.trim()}
      style={color ? { [`--glow-color` as string]: color } : undefined}
    >
      {formattedValue}
      {glowKey > 0 && (
        <span
          key={glowKey}
          className="scoreboard-glow-overlay"
          aria-hidden="true"
        >
          {formattedValue}
        </span>
      )}
    </span>
  )
}

export function ScoreBoard({
  scores = [0, 0, 0, 0],
  className = ``,
}: ScoreBoardProps) {
  const { localBoxesCompleted } = useQuota()

  // Calculate if there are any scores to determine sorting
  const totalClaimed = scores.reduce((a, b) => a + b, 0)
  const hasScores = totalClaimed > 0

  // Create team scores - sort by score if there are any, otherwise keep original order
  const teamScores: Array<TeamScore> = TEAMS.map((team, i) => ({
    team,
    score: scores[i],
    color: TEAM_COLORS[team].primary,
  }))

  // Only sort if there are actual scores
  if (hasScores) {
    teamScores.sort((a, b) => b.score - a.score)
  }

  return (
    <div className={`scoreboard ${className}`.trim()} data-testid="scoreboard">
      {/* Local user's score with person icon */}
      <div
        className="scoreboard-item scoreboard-local"
        data-testid="score-local"
        title="Your completed boxes"
      >
        <svg
          className="scoreboard-icon"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="currentColor"
        >
          <circle cx="12" cy="7" r="4" />
          <path d="M12 14c-6 0-9 3-9 6v1h18v-1c0-3-3-6-9-6z" />
        </svg>
        <AnimatedScore
          value={localBoxesCompleted}
          className="scoreboard-value-local"
          color="rgba(120, 120, 120, 0.8)"
        />
      </div>
      <span className="scoreboard-divider" />
      {teamScores.map(({ team, score, color }) => (
        <div
          key={team}
          className="scoreboard-item"
          data-testid={`score-${team.toLowerCase()}`}
        >
          <span
            className="scoreboard-indicator"
            style={{ background: color }}
          />
          <AnimatedScore value={score} color={color} />
        </div>
      ))}
    </div>
  )
}
