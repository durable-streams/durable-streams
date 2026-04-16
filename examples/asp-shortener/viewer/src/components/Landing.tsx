import { useEffect, useState } from "react"
import type { ResolvedEntry } from "../lib/types"
import { CodeBlock } from "./CopyButton"
import { EmbeddedSession } from "./EmbeddedSession"

interface Props {
  shortUrl: string
  entry: ResolvedEntry
  onWatch: (token: string) => void
  activeToken: string | null
}

function formatTimestamp(ts: number): string {
  return new Intl.DateTimeFormat(undefined, {
    year: `numeric`,
    month: `short`,
    day: `numeric`,
    hour: `2-digit`,
    minute: `2-digit`,
    timeZoneName: `short`,
  }).format(new Date(ts))
}

export function Landing({
  shortUrl,
  entry,
  onWatch,
  activeToken,
}: Props): JSX.Element {
  const [formattedDate, setFormattedDate] = useState(``)

  useEffect(() => {
    setFormattedDate(formatTimestamp(entry.createdAt))
  }, [entry.createdAt])

  const claudeCmd = `asp import ${shortUrl} --agent claude --token <your-token> --resume`
  const codexCmd = `asp import ${shortUrl} --agent codex --token <your-token> --resume`
  const installCmd = `npm install -g @durable-streams/agent-session-protocol`

  return (
    <div className="container">
      <div className="brand">
        <span className="brand-dot"></span>
        <span>Electric</span>
      </div>

      <h1>Shared agent session</h1>
      <p className="lede">
        {entry.live
          ? `A live agent coding session, shared via Electric.`
          : `A snapshot of an agent coding session, shared via Electric.`}
      </p>

      {entry.liveShareUrl && (
        <a className="cross-link" href={entry.liveShareUrl}>
          <span className="badge live">Live</span>
          <span className="cross-link-text">
            A live version of this session is also being shared
          </span>
          <span className="cross-link-arrow" aria-hidden="true">
            →
          </span>
        </a>
      )}

      <dl className="meta">
        <dt>Agent</dt>
        <dd className="agent">{entry.agent}</dd>
        <dt>Mode</dt>
        <dd>
          <span className={`badge ${entry.live ? `live` : `snapshot`}`}>
            {entry.live ? `Live` : `Snapshot`}
          </span>
        </dd>
        <dt>Events</dt>
        <dd>{entry.entryCount}</dd>
        <dt>Shared</dt>
        <dd>{formattedDate}</dd>
        <dt>Session</dt>
        <dd>{entry.sessionId}</dd>
      </dl>

      <div className="prereq">
        <h2>Prerequisites</h2>
        <p className="prereq-intro">
          To resume this session you need the <code>asp</code> CLI installed and
          a valid auth token for the underlying Durable Streams server.
        </p>
        <CodeBlock code={installCmd} />
      </div>

      <h2>Resume in Claude Code</h2>
      <CodeBlock code={claudeCmd} />

      <h2>Resume in Codex</h2>
      <CodeBlock code={codexCmd} />

      <p className="subtle">
        You need a valid auth token to actually import the session.
      </p>

      <EmbeddedSession
        entry={entry}
        token={activeToken}
        onSubmitToken={onWatch}
      />
    </div>
  )
}
