// @refresh skip
import { createMemo } from "solid-js"
import { For } from "solid-js"
import { useWikipediaDB } from "../lib/stream-db"
import { useCollectionData } from "../lib/useCollectionData"
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
  const events = useCollectionData(db.collections.events)

  const topLanguages = createMemo(() => {
    const counts = new Map<string, number>()

    for (const event of events()) {
      counts.set(event.language, (counts.get(event.language) ?? 0) + 1)
    }

    return Array.from(counts.entries())
      .map(([language, count]) => ({ language, count }))
      .sort((a, b) => b.count - a.count || a.language.localeCompare(b.language))
      .slice(0, 10)
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
          <For each={topLanguages()}>
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
