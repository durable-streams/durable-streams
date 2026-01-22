import { useQuota } from "../../contexts/quota-context"
import { QuotaMeter } from "../ui/QuotaMeter"
import { ZoomControls } from "../ui/ZoomControls"
import "./Footer.css"

export function Footer() {
  const { remaining, max, refillIn } = useQuota()

  return (
    <footer className="footer" data-testid="footer">
      <QuotaMeter remaining={remaining} max={max} refillIn={refillIn} />
      <ZoomControls />
    </footer>
  )
}
