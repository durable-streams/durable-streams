import { useCallback, useEffect, useRef, useState } from "react"
import { useAgentLoop } from "./useAgentLoop"
import type { DurableFilesystem } from "@durable-streams/stream-fs"
import type { LogEntry } from "./useAgentLoop"

interface AgentPaneProps {
  name: string
  apiKey: string
  fs: DurableFilesystem | null
}

export default function AgentPane({ name, apiKey, fs }: AgentPaneProps) {
  const { log, running, ready, start, stop, clearLog } = useAgentLoop(
    name,
    apiKey,
    fs
  )
  const [prompt, setPrompt] = useState(``)
  const logEndRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to bottom when new log entries appear
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: `smooth` })
  }, [log.length])

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault()
      const text = prompt.trim()
      if (!text || !ready) return
      setPrompt(``)
      start(text)
    },
    [prompt, ready, start]
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === `Enter` && !e.shiftKey) {
        e.preventDefault()
        handleSubmit(e)
      }
    },
    [handleSubmit]
  )

  return (
    <div className="agent-pane">
      <div className="agent-header">
        <span className="agent-name">{name}</span>
        <div className="agent-header-actions">
          {running && (
            <button className="btn btn-stop" onClick={stop}>
              Stop
            </button>
          )}
          <button
            className="btn btn-clear"
            onClick={clearLog}
            disabled={running}
          >
            Clear
          </button>
        </div>
      </div>

      {/* Action log */}
      <div className="agent-log">
        {!ready && <div className="agent-loading">Connecting...</div>}
        {ready && log.length === 0 && (
          <div className="agent-log-empty">
            Enter a prompt to start the agent
          </div>
        )}
        {log.map((entry) => (
          <LogEntryItem key={entry.id} entry={entry} />
        ))}
        {running && (
          <div className="agent-log-entry agent-log-thinking">
            <span className="log-icon">{`\u25CF`}</span>
            <span className="log-content">Thinking...</span>
          </div>
        )}
        <div ref={logEndRef} />
      </div>

      {/* Prompt input */}
      <form className="agent-prompt" onSubmit={handleSubmit}>
        <textarea
          className="agent-prompt-input"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            !apiKey
              ? `Set API key first...`
              : ready
                ? `Enter a task for this agent...`
                : `Connecting...`
          }
          disabled={!ready || !apiKey}
          rows={2}
        />
        <button
          className="btn btn-run"
          type="submit"
          disabled={!prompt.trim() || !ready || !apiKey}
        >
          Run
        </button>
      </form>
    </div>
  )
}

function LogEntryItem({ entry }: { entry: LogEntry }) {
  const [expanded, setExpanded] = useState(false)

  const icons: Record<string, string> = {
    user: `\u25B6`,
    assistant: `\u2759`,
    tool_call: `\u2699`,
    tool_result: `\u2192`,
    error: `\u2717`,
    done: `\u2713`,
    fs_event: `\u26A1`,
  }

  return (
    <div className={`agent-log-entry agent-log-${entry.type}`}>
      <span className="log-icon">{icons[entry.type] || `\u2022`}</span>
      <div className="log-body">
        <span
          className="log-content"
          onClick={entry.detail ? () => setExpanded(!expanded) : undefined}
          style={entry.detail ? { cursor: `pointer` } : undefined}
        >
          {entry.content}
          {entry.detail && (
            <span className="log-expand">
              {expanded ? ` \u25B4` : ` \u25BE`}
            </span>
          )}
        </span>
        {expanded && entry.detail && (
          <pre className="log-detail">{entry.detail}</pre>
        )}
      </div>
    </div>
  )
}
