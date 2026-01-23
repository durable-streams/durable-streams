import { Dialog } from "@base-ui/react/dialog"
import "./AboutDialog.css"

export interface AboutDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function AboutDialog({ open, onOpenChange }: AboutDialogProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="about-dialog-backdrop" />
        <Dialog.Popup className="about-dialog-popup">
          <Dialog.Title className="about-dialog-title">
            <img
              src="/logo.svg"
              alt="1 Million Boxes"
              className="about-dialog-logo"
            />
          </Dialog.Title>

          <div className="about-dialog-content">
            <p>
              A massive multiplayer Dots &amp; Boxes game with{` `}
              <strong>1,000,000 boxes</strong> on a 1000×1000 grid.
            </p>

            <p>
              Four teams compete to claim boxes by completing their edges. Place
              an edge by clicking between two dots. Complete all four sides of a
              box to claim it for your team!
            </p>

            <div className="about-dialog-teams">
              <div className="about-team about-team-red">
                <span className="about-team-dot" />
                Red Team
              </div>
              <div className="about-team about-team-blue">
                <span className="about-team-dot" />
                Blue Team
              </div>
              <div className="about-team about-team-green">
                <span className="about-team-dot" />
                Green Team
              </div>
              <div className="about-team about-team-yellow">
                <span className="about-team-dot" />
                Yellow Team
              </div>
            </div>

            <p className="about-dialog-tech">
              Built with{` `}
              <a
                href="https://electric-sql.com/product/durable-streams"
                target="_blank"
                rel="noopener noreferrer"
              >
                Durable Streams
              </a>
              {` `}for real-time synchronization.
            </p>
          </div>

          <Dialog.Close className="about-dialog-close-button">
            Got it!
          </Dialog.Close>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
