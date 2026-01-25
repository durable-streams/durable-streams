import { useQuota } from "../../contexts/quota-context"
import "./QuotaMeter.css"

export function QuotaMeter() {
  const { remaining, max, refillIn } = useQuota()

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
      {/* Mobile-only refill text below bars */}
      {remaining < max && (
        <span className="quota-refill-mobile" data-testid="quota-refill-mobile">
          +1 in {refillIn}s
        </span>
      )}
    </div>
  )
}
