import { useEffect, useState } from "react"
import { useQuota } from "../../contexts/quota-context"
import { useTeam } from "../../contexts/team-context"
import "./BonusToast.css"

export function BonusToast() {
  const { bonusCount, bonusPosition, clearBonus } = useQuota()
  const { team } = useTeam()
  const [showBonus, setShowBonus] = useState(false)
  const [bonusText, setBonusText] = useState(``)
  const [position, setPosition] = useState<{ x: number; y: number } | null>(
    null
  )

  // Show bonus toast when boxes are completed
  useEffect(() => {
    if (bonusCount > 0 && bonusPosition) {
      setBonusText(bonusCount > 1 ? `+${bonusCount} Bonus!` : `Bonus!`)
      setPosition(bonusPosition)
      setShowBonus(true)

      // Clear after animation completes
      const timer = setTimeout(() => {
        setShowBonus(false)
        clearBonus()
      }, 1500)

      return () => clearTimeout(timer)
    }
  }, [bonusCount, bonusPosition, clearBonus])

  if (!showBonus || !position) return null

  return (
    <div
      className={`bonus-toast bonus-toast-${team.toLowerCase()}`}
      style={{
        left: position.x,
        top: position.y,
      }}
      data-testid="bonus-toast"
    >
      {bonusText}
    </div>
  )
}
