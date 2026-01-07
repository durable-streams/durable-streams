// @refresh skip
import { For } from "solid-js"
import { useLiveQuery } from "@tanstack/solid-db"
import { count } from "@tanstack/db"
import { useWikipediaDB } from "../lib/stream-db"
import { NAMESPACES } from "../lib/types"
import type { Filters } from "../lib/types"
import "./FilterSidebar.css"

interface FilterSidebarProps {
  filters: Filters
  onToggleLanguage: (lang: string) => void
  onToggleType: (type: string) => void
  onToggleBots: () => void
  onToggleNamespace: (ns: number) => void
  onClearFilters: () => void
}

export function FilterSidebar(props: FilterSidebarProps) {
  const db = useWikipediaDB()

  console.log(`[FilterSidebar] Rendering with db:`, db)
  console.log(`[FilterSidebar] db.collections.events:`, db.collections.events)

  // Query for top languages using DB aggregation
  // Wrap collection access in function to ensure it's accessed reactively
  const topLanguagesQuery = useLiveQuery((q) => {
    const eventsCollection = db.collections.events
    console.log(
      `[FilterSidebar] Inside query, eventsCollection:`,
      eventsCollection
    )

    const languageCounts = q
      .from({ events: eventsCollection })
      .groupBy(({ events }) => events.language)
      .select(({ events }) => ({
        language: events.language,
        count: count(events.id),
      }))

    return q
      .from({ stats: languageCounts })
      .orderBy(({ stats }) => stats.count, `desc`)
      .limit(10)
  })

  const eventTypes = [`edit`, `new`, `log`, `categorize`]

  return (
    <aside class="filter-sidebar">
      <div class="sidebar-header">
        <h2>Filters</h2>
        <button
          class="clear-button"
          onClick={props.onClearFilters}
          title="Clear all filters"
        >
          Clear
        </button>
      </div>

      {/* Language Filter */}
      <section class="filter-section">
        <h3>Language</h3>
        <div class="filter-options">
          <For each={topLanguagesQuery.data}>
            {(item) => (
              <label class="filter-option">
                <input
                  type="checkbox"
                  checked={props.filters.languages.has(item.language)}
                  onChange={() => props.onToggleLanguage(item.language)}
                />
                <span class="filter-label">
                  {item.language} ({item.count})
                </span>
              </label>
            )}
          </For>
        </div>
      </section>

      {/* Event Type Filter */}
      <section class="filter-section">
        <h3>Event Type</h3>
        <div class="filter-options">
          <For each={eventTypes}>
            {(type) => (
              <label class="filter-option">
                <input
                  type="checkbox"
                  checked={props.filters.types.has(type)}
                  onChange={() => props.onToggleType(type)}
                />
                <span class="filter-label">{type}</span>
              </label>
            )}
          </For>
        </div>
      </section>

      {/* Bot Filter */}
      <section class="filter-section">
        <h3>Contributors</h3>
        <div class="filter-options">
          <label class="filter-option">
            <input
              type="checkbox"
              checked={props.filters.showBots}
              onChange={props.onToggleBots}
            />
            <span class="filter-label">Show bot edits 🤖</span>
          </label>
        </div>
      </section>

      {/* Namespace Filter */}
      <section class="filter-section">
        <h3>Namespace</h3>
        <div class="filter-options">
          <For each={NAMESPACES}>
            {(ns) => (
              <label class="filter-option">
                <input
                  type="checkbox"
                  checked={props.filters.namespaces.has(ns.id)}
                  onChange={() => props.onToggleNamespace(ns.id)}
                />
                <span class="filter-label">{ns.name}</span>
              </label>
            )}
          </For>
        </div>
      </section>
    </aside>
  )
}
