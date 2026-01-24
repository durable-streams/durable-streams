import { QuotaMeter } from "../ui/QuotaMeter"
import { ZoomControls } from "../ui/ZoomControls"
import "./Footer.css"

export function Footer() {
  return (
    <footer className="footer" data-testid="footer">
      <div className="footer-left">
        <QuotaMeter />
      </div>
      <a
        href="https://durable.ws"
        target="_blank"
        rel="noopener noreferrer"
        className="footer-link"
      >
        Learn how we built this
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
          <polyline points="15 3 21 3 21 9" />
          <line x1="10" y1="14" x2="21" y2="3" />
        </svg>
      </a>
      <div className="footer-right">
        <ZoomControls className="footer-zoom-controls" />
      </div>
    </footer>
  )
}
