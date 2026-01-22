import { QuotaMeter } from "../ui/QuotaMeter"
import { ZoomControls } from "../ui/ZoomControls"
import "./Footer.css"

export function Footer() {
  return (
    <footer className="footer" data-testid="footer">
      <QuotaMeter />
      <ZoomControls />
    </footer>
  )
}
