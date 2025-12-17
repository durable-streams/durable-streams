// @refresh skip
import { For } from "solid-js"
import { useLiveQuery } from "@tanstack/solid-db"
import { and, eq, inArray } from "@tanstack/db"
import { useWikipediaDB } from "../lib/stream-db"
import { EventCard } from "./EventCard"
import type { Filters } from "../lib/types"
import "./EventList.css"

interface EventListProps {
  filters: Filters
}

export function EventList(props: EventListProps) {
  const db = useWikipediaDB()

  // Build query with filters pushed into the DB query engine
  const eventsQuery = useLiveQuery((q) => {
    let query = q.from({ events: db.collections.events })

    // Build WHERE clause dynamically inside callback
    const hasLanguageFilter = props.filters.languages.size > 0
    const hasTypeFilter = props.filters.types.size > 0
    const hasBotFilter = !props.filters.showBots
    const hasNamespaceFilter = props.filters.namespaces.size > 0

    // Only add WHERE clause if there are active filters
    if (
      hasLanguageFilter ||
      hasTypeFilter ||
      hasBotFilter ||
      hasNamespaceFilter
    ) {
      query = query.where(({ events }) => {
        const conditions = []

        // Language filter
        if (hasLanguageFilter) {
          conditions.push(
            inArray(events.language, Array.from(props.filters.languages))
          )
        }

        // Type filter
        if (hasTypeFilter) {
          conditions.push(inArray(events.type, Array.from(props.filters.types)))
        }

        // Bot filter
        if (hasBotFilter) {
          conditions.push(eq(events.isBot, false))
        }

        // Namespace filter
        if (hasNamespaceFilter) {
          conditions.push(
            inArray(events.namespace, Array.from(props.filters.namespaces))
          )
        }

        // Combine conditions with and()
        if (conditions.length === 1) return conditions[0]
        if (conditions.length === 2) return and(conditions[0], conditions[1])
        if (conditions.length === 3)
          return and(conditions[0], conditions[1], conditions[2])
        return and(conditions[0], conditions[1], conditions[2], conditions[3])
      })
    }

    // Sort by timestamp descending and limit to 100
    return query.orderBy(({ events }) => events.timestamp, `desc`).limit(100)
  })

  return (
    <div class="event-list">
      <div class="event-list-header">
        <h2>Live Events</h2>
        <div class="event-count">Showing {eventsQuery.data.length} events</div>
      </div>

      <div class="events-container">
        <For
          each={eventsQuery.data}
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
