import { Show } from "solid-js"
import type { WikipediaEvent } from "../lib/types"
import "./EventCard.css"

interface EventCardProps {
  event: WikipediaEvent
}

export function EventCard(props: EventCardProps) {
  const lengthChange = () => props.event.lengthNew - props.event.lengthOld

  const formatTimestamp = (isoString: string) => {
    const date = new Date(isoString)
    const now = new Date()
    const diff = now.getTime() - date.getTime()
    const seconds = Math.floor(diff / 1000)

    if (seconds < 60) return `${seconds}s ago`
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
    return date.toLocaleDateString()
  }

  return (
    <div
      class="event-card"
      classList={{
        "is-bot": props.event.isBot,
        [`type-${props.event.type}`]: true,
      }}
    >
      <div class="event-header">
        <span class="language-badge">{props.event.language}</span>
        <span class="type-badge">{props.event.type}</span>
        <Show when={props.event.isBot}>
          <span class="bot-badge" title="Bot edit">
            🤖
          </span>
        </Show>
      </div>

      <a
        href={props.event.eventUrl}
        target="_blank"
        rel="noopener noreferrer"
        class="event-title"
      >
        {props.event.title}
      </a>

      <div class="event-meta">
        <span class="user" title={`User: ${props.event.user}`}>
          👤 {props.event.user}
        </span>
        <span class="timestamp">{formatTimestamp(props.event.timestamp)}</span>
        <Show when={lengthChange() !== 0}>
          <span
            class="length-change"
            classList={{
              positive: lengthChange() > 0,
              negative: lengthChange() < 0,
            }}
            title={`Byte change: ${lengthChange()}`}
          >
            {lengthChange() > 0 ? `+` : ``}
            {lengthChange()}
          </span>
        </Show>
      </div>

      <Show when={props.event.comment}>
        <div class="comment" title={props.event.comment}>
          {props.event.comment}
        </div>
      </Show>
    </div>
  )
}
