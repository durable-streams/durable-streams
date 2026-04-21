import { useEffect, useRef, useState } from "react"

const NAME_STORAGE_KEY = `live-share-user-name`

interface Props {
  // Base URL of the live session's DS stream (e.g.
  // https://.../asp/<sessionId>/live). We POST prompts to `${fullUrl}/prompts`.
  fullUrl: string
  token: string
  // Disabled when the session has ended — no live Claude to consume prompts.
  disabled?: boolean
}

type SubmitState =
  | { kind: `idle` }
  | { kind: `sending` }
  | { kind: `sent` }
  | { kind: `error`; message: string }

export function PromptInput({ fullUrl, token, disabled }: Props): JSX.Element {
  const [text, setText] = useState(``)
  const [name, setName] = useState(() => {
    if (typeof window === `undefined`) return ``
    return window.localStorage.getItem(NAME_STORAGE_KEY) ?? ``
  })
  const [submitState, setSubmitState] = useState<SubmitState>({ kind: `idle` })
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (submitState.kind !== `sent`) return
    // Clear the "sent" badge after a moment so it's not sticky.
    const id = setTimeout(() => setSubmitState({ kind: `idle` }), 2000)
    return () => clearTimeout(id)
  }, [submitState])

  const persistName = (next: string): void => {
    setName(next)
    if (typeof window !== `undefined`) {
      if (next.trim()) {
        window.localStorage.setItem(NAME_STORAGE_KEY, next.trim())
      } else {
        window.localStorage.removeItem(NAME_STORAGE_KEY)
      }
    }
  }

  const submit = async (): Promise<void> => {
    const trimmed = text.trim()
    if (!trimmed || disabled) return
    setSubmitState({ kind: `sending` })

    const body = {
      v: 1,
      ts: Date.now(),
      type: `prompt`,
      text: trimmed,
      user: name.trim() ? { name: name.trim() } : undefined,
    }

    try {
      const res = await fetch(`${fullUrl}/prompts`, {
        method: `POST`,
        headers: {
          "Content-Type": `application/json`,
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const errText = await res.text().catch(() => ``)
        throw new Error(`HTTP ${res.status}${errText ? `: ${errText}` : ``}`)
      }
      setText(``)
      setSubmitState({ kind: `sent` })
      // Keep focus in the textarea so you can fire off another prompt fast.
      textareaRef.current?.focus()
    } catch (error) {
      setSubmitState({
        kind: `error`,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    // Enter submits, Shift+Enter inserts a newline (standard chat UX).
    if (e.key === `Enter` && !e.shiftKey) {
      e.preventDefault()
      void submit()
    }
  }

  const canSubmit =
    !disabled && text.trim().length > 0 && submitState.kind !== `sending`

  return (
    <div className="prompt-input">
      <div className="prompt-input-name-row">
        <label className="prompt-input-name-label">
          Your name (shown to the sharer):
          <input
            type="text"
            value={name}
            onChange={(e) => persistName(e.target.value)}
            placeholder="anonymous"
            className="prompt-input-name"
            maxLength={40}
            disabled={disabled}
          />
        </label>
        {submitState.kind === `sending` && (
          <span className="prompt-input-status sending">Sending…</span>
        )}
        {submitState.kind === `sent` && (
          <span className="prompt-input-status sent">Sent ✓</span>
        )}
        {submitState.kind === `error` && (
          <span
            className="prompt-input-status error"
            title={submitState.message}
          >
            Failed — {submitState.message}
          </span>
        )}
      </div>
      <form
        className="prompt-input-form"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <textarea
          ref={textareaRef}
          className="prompt-input-textarea"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={
            disabled
              ? `Session ended — no active agent to receive prompts.`
              : `Type a prompt for the live session. Enter to send; Shift+Enter for a new line.`
          }
          rows={2}
          disabled={disabled}
          aria-label="Prompt for live session"
        />
        <button
          type="submit"
          className="btn primary prompt-input-submit"
          disabled={!canSubmit}
        >
          Send
        </button>
      </form>
    </div>
  )
}
