import { createStore } from "solid-js/store"
import { WikipediaDBProvider } from "./lib/stream-db"
import { EventList } from "./components/EventList"
import { FilterSidebar } from "./components/FilterSidebar"
import { StatsPanel } from "./components/StatsPanel"
import type { Filters } from "./lib/types"
import "./App.css"

export function App() {
  const [filters, setFilters] = createStore<Filters>({
    languages: new Set<string>(),
    types: new Set<string>(),
    showBots: true,
    namespaces: new Set<number>(),
  })

  const toggleLanguage = (lang: string) => {
    setFilters(`languages`, (langs) => {
      const newSet = new Set(langs)
      if (newSet.has(lang)) {
        newSet.delete(lang)
      } else {
        newSet.add(lang)
      }
      return newSet
    })
  }

  const toggleType = (type: string) => {
    setFilters(`types`, (types) => {
      const newSet = new Set(types)
      if (newSet.has(type)) {
        newSet.delete(type)
      } else {
        newSet.add(type)
      }
      return newSet
    })
  }

  const toggleBots = () => {
    setFilters(`showBots`, (current) => !current)
  }

  const toggleNamespace = (ns: number) => {
    setFilters(`namespaces`, (namespaces) => {
      const newSet = new Set(namespaces)
      if (newSet.has(ns)) {
        newSet.delete(ns)
      } else {
        newSet.add(ns)
      }
      return newSet
    })
  }

  const clearFilters = () => {
    setFilters({
      languages: new Set(),
      types: new Set(),
      showBots: true,
      namespaces: new Set(),
    })
  }

  return (
    <WikipediaDBProvider>
      <div class="app">
        <header class="app-header">
          <h1>📡 Wikipedia EventStreams</h1>
          <p>
            Real-time edits from Wikipedia powered by Durable Streams + Solid.js
          </p>
        </header>

        <div class="app-grid">
          <FilterSidebar
            filters={filters}
            onToggleLanguage={toggleLanguage}
            onToggleType={toggleType}
            onToggleBots={toggleBots}
            onToggleNamespace={toggleNamespace}
            onClearFilters={clearFilters}
          />

          <main class="app-main">
            <EventList filters={filters} />
          </main>

          <StatsPanel />
        </div>
      </div>
    </WikipediaDBProvider>
  )
}
