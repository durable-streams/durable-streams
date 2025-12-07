import { createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute(`/`)({
  component: Index,
})

function Index() {
  return <div className="placeholder">Select a stream to start</div>
}
