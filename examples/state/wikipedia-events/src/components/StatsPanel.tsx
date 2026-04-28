// @refresh skip
import { For, createMemo } from "solid-js"
import { useWikipediaDB } from "../lib/stream-db"
import { useCollectionData } from "../lib/useCollectionData"
import "./StatsPanel.css"

export function StatsPanel() {
  const db = useWikipediaDB()
  const events = useCollectionData(db.collections.events)

  const totalEvents = createMemo(() => events().length)

  const topLanguages = createMemo(() => {
    const counts = new Map<string, number>()

    for (const event of events()) {
      counts.set(event.language, (counts.get(event.language) ?? 0) + 1)
    }

    return Array.from(counts.entries())
      .map(([language, count]) => ({ language, count }))
      .sort((a, b) => b.count - a.count || a.language.localeCompare(b.language))
      .slice(0, 5)
  })

  const typeBreakdown = createMemo(() => {
    const counts = new Map<string, number>()

    for (const event of events()) {
      counts.set(event.type, (counts.get(event.type) ?? 0) + 1)
    }

    return Array.from(counts.entries())
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type))
  })

  const botStats = createMemo(() => {
    let botCount = 0
    let humanCount = 0

    for (const event of events()) {
      if (event.isBot) {
        botCount += 1
      } else {
        humanCount += 1
      }
    }

    return { botCount, humanCount }
  })

  const topUsers = createMemo(() => {
    const counts = new Map<string, number>()

    for (const event of events()) {
      if (event.isBot) continue
      counts.set(event.user, (counts.get(event.user) ?? 0) + 1)
    }

    return Array.from(counts.entries())
      .map(([user, count]) => ({ user, count }))
      .sort((a, b) => b.count - a.count || a.user.localeCompare(b.user))
      .slice(0, 5)
  })

  const recentEvents = createMemo(() =>
    [...events()]
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .slice(0, 100)
  )

  const eventsPerSec = createMemo(() => {
    const recent = recentEvents()
    if (recent.length < 2) return `0.00`

    const oldest = new Date(recent[recent.length - 1].timestamp).getTime()
    const newest = new Date(recent[0].timestamp).getTime()
    const seconds = (newest - oldest) / 1000

    return seconds > 0 ? (recent.length / seconds).toFixed(2) : `0.00`
  })

  const botRatio = createMemo(() => {
    const { botCount, humanCount } = botStats()
    const total = botCount + humanCount
    return total > 0 ? ((botCount / total) * 100).toFixed(1) : `0.0`
  })

  return (
    <aside class="stats-panel">
      <div class="stats-header">
        <h2>Statistics</h2>
        <div class="stats-subtitle">Last 100 events</div>
      </div>

      <div class="stat-card">
        <div class="stat-icon">📊</div>
        <div class="stat-content">
          <div class="stat-label">Events/sec</div>
          <div class="stat-value">{eventsPerSec()}</div>
        </div>
      </div>

      <div class="stat-card">
        <div class="stat-icon">🌍</div>
        <div class="stat-content">
          <div class="stat-label">Total Events</div>
          <div class="stat-value">{totalEvents()}</div>
        </div>
      </div>

      <div class="stat-section">
        <h3>🌐 Top Languages</h3>
        <div class="stat-list">
          <For
            each={topLanguages()}
            fallback={<div class="stat-empty">No data yet</div>}
          >
            {(item) => (
              <div class="stat-item">
                <span class="stat-item-label">{item.language}</span>
                <span class="stat-item-value">{item.count}</span>
              </div>
            )}
          </For>
        </div>
      </div>

      <div class="stat-section">
        <h3>📝 Event Types</h3>
        <div class="stat-list">
          <For
            each={typeBreakdown()}
            fallback={<div class="stat-empty">No data yet</div>}
          >
            {(item) => (
              <div class="stat-item">
                <span class="stat-item-label">{item.type}</span>
                <span class="stat-item-value">{item.count}</span>
              </div>
            )}
          </For>
        </div>
      </div>

      <div class="stat-card bot-stat">
        <div class="stat-icon">🤖</div>
        <div class="stat-content">
          <div class="stat-label">Bot Activity</div>
          <div class="stat-value">{botRatio()}%</div>
        </div>
      </div>

      <div class="stat-section">
        <h3>👥 Active Users</h3>
        <div class="stat-list">
          <For
            each={topUsers()}
            fallback={<div class="stat-empty">No data yet</div>}
          >
            {(item) => (
              <div class="stat-item">
                <span class="stat-item-label" title={item.user}>
                  {item.user}
                </span>
                <span class="stat-item-value">{item.count}</span>
              </div>
            )}
          </For>
        </div>
      </div>
    </aside>
  )
}
