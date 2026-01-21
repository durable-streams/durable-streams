// @refresh skip
import { For, createMemo } from "solid-js"
import { useLiveQuery } from "@tanstack/solid-db"
import { count, eq } from "@tanstack/db"
import { useWikipediaDB } from "../lib/stream-db"
import "./StatsPanel.css"

export function StatsPanel() {
  const db = useWikipediaDB()

  // Total events count
  const totalQuery = useLiveQuery((q) =>
    q
      .from({ events: db.collections.events })
      .select(({ events }) => ({ total: count(events.id) }))
  )

  // Top 5 languages with DB aggregation
  const topLanguagesQuery = useLiveQuery((q) => {
    const languageCounts = q
      .from({ events: db.collections.events })
      .groupBy(({ events }) => events.language)
      .select(({ events }) => ({
        language: events.language,
        count: count(events.id),
      }))

    return q
      .from({ stats: languageCounts })
      .orderBy(({ stats }) => stats.count, `desc`)
      .limit(5)
  })

  // Event type breakdown with DB aggregation
  const typeBreakdownQuery = useLiveQuery((q) =>
    q
      .from({ events: db.collections.events })
      .groupBy(({ events }) => events.type)
      .select(({ events }) => ({
        type: events.type,
        count: count(events.id),
      }))
  )

  // Bot vs human ratio with DB aggregation
  const botStatsQuery = useLiveQuery((q) =>
    q
      .from({ events: db.collections.events })
      .groupBy(({ events }) => events.isBot)
      .select(({ events }) => ({
        isBot: events.isBot,
        count: count(events.id),
      }))
  )

  // Top 5 active users (non-bots) with DB aggregation
  const topUsersQuery = useLiveQuery((q) => {
    const userCounts = q
      .from({ events: db.collections.events })
      .where(({ events }) => eq(events.isBot, false))
      .groupBy(({ events }) => events.user)
      .select(({ events }) => ({
        user: events.user,
        count: count(events.id),
      }))

    return q
      .from({ stats: userCounts })
      .orderBy(({ stats }) => stats.count, `desc`)
      .limit(5)
  })

  // Events per second - need recent 100 for time calculation
  const recentEventsQuery = useLiveQuery((q) =>
    q
      .from({ events: db.collections.events })
      .orderBy(({ events }) => events.timestamp, `desc`)
      .limit(100)
      .select(({ events }) => ({
        timestamp: events.timestamp,
      }))
  )

  const eventsPerSec = createMemo(() => {
    const recent = recentEventsQuery.data
    if (recent.length < 2) return `0.00`

    const oldest = new Date(recent[recent.length - 1].timestamp).getTime()
    const newest = new Date(recent[0].timestamp).getTime()
    const seconds = (newest - oldest) / 1000

    return seconds > 0 ? (recent.length / seconds).toFixed(2) : `0.00`
  })

  const botRatio = createMemo(() => {
    const stats = botStatsQuery.data
    const botCount = stats.find((s: any) => s.isBot)?.count || 0
    const humanCount = stats.find((s: any) => !s.isBot)?.count || 0
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
          <div class="stat-value">{totalQuery.data[0]?.total || 0}</div>
        </div>
      </div>

      <div class="stat-section">
        <h3>🌐 Top Languages</h3>
        <div class="stat-list">
          <For
            each={topLanguagesQuery.data}
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
            each={typeBreakdownQuery.data}
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
            each={topUsersQuery.data}
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
