import { useEffect, useState } from "react"
import { useQuota } from "../../contexts/quota-context"
import { useTeam } from "../../contexts/team-context"
import "./QuotaMeter.css"

export function QuotaMeter() {
  const { remaining, max, refillIn, bonusCount, clearBonus } = useQuota()
  const { team } = useTeam()
  const [showBonus, setShowBonus] = useState(false)
  const [bonusText, setBonusText] = useState(``)

  // Show bonus toast when boxes are completed
  useEffect(() => {
    if (bonusCount > 0) {
      setBonusText(bonusCount > 1 ? `+${bonusCount} Bonus!` : `Bonus!`)
      setShowBonus(true)

      // Clear after animation completes
      const timer = setTimeout(() => {
        setShowBonus(false)
        clearBonus()
      }, 1500)

      return () => clearTimeout(timer)
    }
  }, [bonusCount, clearBonus])

  const color = remaining > 5 ? `full` : remaining > 2 ? `mid` : `low`
  const isEmpty = remaining === 0

  // Create segments for visual display
  const segments = Array.from({ length: max }, (_, i) => i < remaining)

  return (
    <div
      className={`quota-meter ${isEmpty ? `quota-recharging` : ``}`}
      data-testid="quota-meter"
    >
      <div className="quota-segments" data-testid="quota-segments">
        {/* Bonus toast - positioned over segments, colored by team */}
        {showBonus && (
          <div
            className={`quota-bonus-toast quota-bonus-${team.toLowerCase()}`}
            data-testid="quota-bonus"
          >
            {bonusText}
          </div>
        )}
        {segments.map((filled, i) => (
          <div
            key={i}
            className={`quota-segment ${filled ? `quota-segment-filled quota-${color}` : `quota-segment-empty`}`}
            data-testid={`quota-segment-${i}`}
          />
        ))}
      </div>
      <span className="quota-text" data-testid="quota-text">
        {isEmpty ? (
          <span className="quota-recharging-text">Recharging...</span>
        ) : (
          `${remaining}/${max}`
        )}
      </span>
      {remaining < max && (
        <span className="quota-refill" data-testid="quota-refill">
          +1 in {refillIn}s
        </span>
      )}
    </div>
  )
}
