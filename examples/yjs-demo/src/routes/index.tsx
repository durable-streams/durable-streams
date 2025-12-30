import { createFileRoute } from "@tanstack/react-router"

function Index() {
  return (
    <div className="welcome">
      <h2>Welcome to Yjs Collaborative Editor</h2>
      <p>Create a room or select an existing one to start collaborating.</p>
      <div className="features">
        <div className="feature">
          <h3>Real-time Collaboration</h3>
          <p>Multiple users can edit the same document simultaneously.</p>
        </div>
        <div className="feature">
          <h3>Conflict-free Editing</h3>
          <p>Yjs CRDTs ensure all edits merge automatically.</p>
        </div>
        <div className="feature">
          <h3>Durable Storage</h3>
          <p>All changes are persisted via Durable Streams.</p>
        </div>
      </div>
    </div>
  )
}

export const Route = createFileRoute(`/`)({
  component: Index,
})
