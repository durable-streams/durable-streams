import { useEffect, useRef, useState } from "react"
import { useQuota } from "../../contexts/quota-context"
import { useTeam } from "../../contexts/team-context"
import { QUOTA_BONUS_DOUBLE, QUOTA_BONUS_SINGLE } from "../../lib/config"
import "./BonusToast.css"

interface ToastInstance {
  id: number
  text: string
  x: number
  y: number
}

export function BonusToast() {
  const { bonusCount, bonusPosition, clearBonus } = useQuota()
  const { team } = useTeam()
  const [toasts, setToasts] = useState<Array<ToastInstance>>([])
  const nextIdRef = useRef(0)

  // Add a new toast when bonus is earned
  // bonusCount is the number of boxes claimed (1 or 2)
  // We display the actual token bonus from config
  useEffect(() => {
    if (bonusCount > 0 && bonusPosition) {
      const tokenBonus =
        bonusCount >= 2 ? QUOTA_BONUS_DOUBLE : QUOTA_BONUS_SINGLE
      const id = nextIdRef.current++

      setToasts((prev) => [
        ...prev,
        {
          id,
          text: `+${tokenBonus} Bonus!`,
          x: bonusPosition.x,
          y: bonusPosition.y,
        },
      ])

      // Clear this toast after animation completes
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id))
      }, 1500)

      // Clear the bonus state so new bonuses can be detected
      clearBonus()
    }
  }, [bonusCount, bonusPosition, clearBonus])

  if (toasts.length === 0) return null

  return (
    <>
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`bonus-toast bonus-toast-${team.toLowerCase()}`}
          style={{
            left: toast.x,
            top: toast.y,
          }}
          data-testid="bonus-toast"
        >
          {toast.text}
        </div>
      ))}
    </>
  )
}
