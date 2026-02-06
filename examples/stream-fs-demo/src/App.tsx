import { useState } from "react"
import AgentPane from "./AgentPane"

const DEFAULT_BASE_URL = `http://localhost:4437`

function generatePrefix(): string {
  return `/fs/demo-${Math.random().toString(36).slice(2, 8)}`
}

export default function App() {
  const params = new URLSearchParams(window.location.search)
  const [baseUrl] = useState(params.get(`server`) || DEFAULT_BASE_URL)
  const [streamPrefix] = useState(params.get(`prefix`) || generatePrefix)

  return (
    <div className="app">
      <header className="app-header">
        <h1>Stream-FS Demo</h1>
        <div className="app-info">
          <span className="info-label">Server:</span>
          <code>{baseUrl}</code>
          <span className="info-label">Prefix:</span>
          <code>{streamPrefix}</code>
        </div>
      </header>
      <main className="app-main">
        <AgentPane
          name="Agent A"
          baseUrl={baseUrl}
          streamPrefix={streamPrefix}
        />
        <AgentPane
          name="Agent B"
          baseUrl={baseUrl}
          streamPrefix={streamPrefix}
        />
      </main>
    </div>
  )
}
