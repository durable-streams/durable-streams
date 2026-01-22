import { useCallback, useState } from "react"
import { Dialog } from "@base-ui/react/dialog"
import "./ShareDialog.css"

export interface ShareDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ShareDialog({ open, onOpenChange }: ShareDialogProps) {
  const [copied, setCopied] = useState(false)

  const shareUrl = typeof window !== `undefined` ? window.location.href : ``

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(shareUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Fallback for older browsers
      const input = document.querySelector(`.share-dialog-input`)
      input?.select()
      document.execCommand(`copy`)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }, [shareUrl])

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="share-dialog-backdrop" />
        <Dialog.Popup className="share-dialog-popup">
          <Dialog.Title className="share-dialog-title">
            Share this game
          </Dialog.Title>
          <Dialog.Description className="share-dialog-description">
            Copy the link below to share with friends
          </Dialog.Description>

          <div className="share-dialog-content">
            <input
              type="text"
              className="share-dialog-input"
              value={shareUrl}
              readOnly
              onClick={(e) => (e.target as HTMLInputElement).select()}
            />
            <button
              className={`share-dialog-copy-button ${copied ? `copied` : ``}`}
              onClick={handleCopy}
            >
              {copied ? `Copied!` : `Copy`}
            </button>
          </div>

          <Dialog.Close className="share-dialog-close-button">
            Close
          </Dialog.Close>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
