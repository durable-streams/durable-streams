import { useCallback, useState } from "react"
import { Dialog } from "@base-ui/react/dialog"
import "./ShareDialog.css"

export interface ShareDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * Check if the Web Share API is available.
 */
function canUseNativeShare(): boolean {
  return typeof navigator !== `undefined` && `share` in navigator
}

export function ShareDialog({ open, onOpenChange }: ShareDialogProps) {
  const [copied, setCopied] = useState(false)

  const shareUrl = typeof window !== `undefined` ? window.location.href : ``
  const supportsNativeShare = canUseNativeShare()

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

  const handleNativeShare = useCallback(async () => {
    try {
      await navigator.share({
        title: `1 Million Boxes`,
        text: `Join me in this massive multiplayer Dots & Boxes game!`,
        url: shareUrl,
      })
      // Close dialog after successful share
      onOpenChange(false)
    } catch (err) {
      // User cancelled or share failed - ignore
      if (err instanceof Error && err.name !== `AbortError`) {
        console.error(`Share failed:`, err)
      }
    }
  }, [shareUrl, onOpenChange])

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="share-dialog-backdrop" />
        <Dialog.Popup className="share-dialog-popup">
          <Dialog.Title className="share-dialog-title">
            Share this game
          </Dialog.Title>
          <Dialog.Description className="share-dialog-description">
            Invite friends to join the game
          </Dialog.Description>

          {supportsNativeShare && (
            <button
              className="share-dialog-native-button"
              onClick={handleNativeShare}
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="18" cy="5" r="3" />
                <circle cx="6" cy="12" r="3" />
                <circle cx="18" cy="19" r="3" />
                <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
                <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
              </svg>
              Share via...
            </button>
          )}

          <div className="share-dialog-divider">
            <span>or copy link</span>
          </div>

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
