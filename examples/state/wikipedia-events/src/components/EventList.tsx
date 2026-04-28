// @refresh skip
import { createMemo } from "solid-js"
import { For } from "solid-js"
import { useWikipediaDB } from "../lib/stream-db"
import { useCollectionData } from "../lib/useCollectionData"
import { EventCard } from "./EventCard"
import type { Filters } from "../lib/types"
import "./EventList.css"

interface EventListProps {
  filters: Filters
}

export function EventList(props: EventListProps) {
  const db = useWikipediaDB()
  const events = useCollectionData(db.collections.events)

  const visibleEvents = createMemo(() => {
    const hasLanguageFilter = props.filters.languages.size > 0
    const hasTypeFilter = props.filters.types.size > 0
    const hasBotFilter = !props.filters.showBots
    const hasNamespaceFilter = props.filters.namespaces.size > 0

    return [...events()]
      .filter((event) => {
        if (hasLanguageFilter && !props.filters.languages.has(event.language)) {
          return false
        }
        if (hasTypeFilter && !props.filters.types.has(event.type)) {
          return false
        }
        if (hasBotFilter && event.isBot) {
          return false
        }
        if (
          hasNamespaceFilter &&
          !props.filters.namespaces.has(event.namespace)
        ) {
          return false
        }
        return true
      })
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .slice(0, 100)
  })

  return (
    <div class="event-list">
      <div class="event-list-header">
        <h2>Live Events</h2>
        <div class="event-count">Showing {visibleEvents().length} events</div>
      </div>

      <div class="events-container">
        <For
          each={visibleEvents()}
          fallback={<EmptyState filters={props.filters} />}
        >
          {(event) => <EventCard event={event} />}
        </For>
      </div>
    </div>
  )
}

function EmptyState(props: { filters: Filters }) {
  const hasActiveFilters = () => {
    return (
      props.filters.languages.size > 0 ||
      props.filters.types.size > 0 ||
      !props.filters.showBots ||
      props.filters.namespaces.size > 0
    )
  }

  return (
    <div class="empty-state">
      <div class="empty-icon">📭</div>
      {hasActiveFilters() ? (
        <>
          <h3>No events match your filters</h3>
          <p>Try adjusting your filter selections</p>
        </>
      ) : (
        <>
          <h3>No events yet</h3>
          <p>Waiting for Wikipedia events to stream in...</p>
          <p class="help-text">
            Make sure the Wikipedia worker is running and connected to the
            stream
          </p>
        </>
      )}
    </div>
  )
}
