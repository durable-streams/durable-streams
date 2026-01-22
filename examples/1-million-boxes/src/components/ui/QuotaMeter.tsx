import { Progress } from "@base-ui/react/progress"
import "./QuotaMeter.css"

export interface QuotaMeterProps {
  remaining: number
  max: number
  refillIn: number
}

export function QuotaMeter({ remaining, max, refillIn }: QuotaMeterProps) {
  const color = remaining > 5 ? `full` : remaining > 2 ? `mid` : `low`

  return (
    <div className="quota-meter" data-testid="quota-meter">
      <Progress.Root value={remaining} max={max} className="quota-progress">
        <Progress.Track className="quota-track">
          <Progress.Indicator className={`quota-indicator quota-${color}`} />
        </Progress.Track>
      </Progress.Root>
      <span className="quota-text" data-testid="quota-text">
        {remaining}/{max} lines
      </span>
      {remaining < max && (
        <span className="quota-refill" data-testid="quota-refill">
          +1 in {refillIn}s
        </span>
      )}
    </div>
  )
}
