import { createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute(`/session/`)({
  component: SessionIndexPage,
})

function SessionIndexPage() {
  return (
    <section className="session-stage empty-stage">
      <p className="eyebrow">Overview</p>
      <h2>Start a shared coding session</h2>
      <p className="stage-copy">
        Use the sidebar to create a Claude or Codex session, then open the same
        URL in a second tab to verify prompts, approvals, and bridge restarts
        behave the way you expect.
      </p>
      <div className="empty-grid">
        <article className="empty-card">
          <strong>What this tests</strong>
          <p>
            Browser prompt writes, approval handling, interrupt flow, raw event
            visibility, and real bridge lifecycle controls.
          </p>
        </article>
        <article className="empty-card">
          <strong>Missing features already exposed</strong>
          <p>
            The current package client API does not yet expose approval-cancel
            writes or an abortable live event subscription, so this prototype
            uses a thin browser helper on top of Durable Streams directly.
          </p>
        </article>
      </div>
    </section>
  )
}
