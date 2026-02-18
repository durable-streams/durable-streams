import { useCallback, useState } from "react"
import AgentPane from "./AgentPane"
import FileViewer from "./FileViewer"
import { useMetadataDB } from "./useMetadataDB"
import { useSharedFilesystem } from "./useFilesystem"

const DEFAULT_BASE_URL = `http://localhost:4437`
const API_KEY_STORAGE_KEY = `stream-fs-demo-api-key`

function generatePrefix(): string {
  return `/fs/demo-${Math.random().toString(36).slice(2, 8)}`
}

let nextAgentId = 0
function createAgent(name: string) {
  return { id: nextAgentId++, name }
}

export default function App() {
  const params = new URLSearchParams(window.location.search)
  const [baseUrl] = useState(params.get(`server`) || DEFAULT_BASE_URL)
  const [streamPrefix] = useState(params.get(`prefix`) || generatePrefix)
  const [apiKey, setApiKey] = useState(
    () => localStorage.getItem(API_KEY_STORAGE_KEY) || ``
  )
  const [agents, setAgents] = useState(() => [
    createAgent(`Agent A`),
    createAgent(`Agent B`),
  ])

  const metadataDB = useMetadataDB(baseUrl, streamPrefix)
  const fs = useSharedFilesystem(baseUrl, streamPrefix, metadataDB !== null)

  const handleApiKeyChange = useCallback((value: string) => {
    setApiKey(value)
    localStorage.setItem(API_KEY_STORAGE_KEY, value)
  }, [])

  const addAgent = useCallback(() => {
    const letter = String.fromCharCode(65 + agents.length)
    setAgents((prev) => [...prev, createAgent(`Agent ${letter}`)])
  }, [agents.length])

  return (
    <div className="app">
      <header className="app-header">
        <h1>Stream-FS Agent Demo</h1>
        <div className="app-info">
          <span className="info-label">Server:</span>
          <code>{baseUrl}</code>
          <span className="info-label">Prefix:</span>
          <code>{streamPrefix}</code>
        </div>
        <div className="header-spacer" />
        <div className="api-key-field">
          <label className="info-label" htmlFor="api-key">
            API Key:
          </label>
          <input
            id="api-key"
            type="password"
            className="api-key-input"
            value={apiKey}
            onChange={(e) => handleApiKeyChange(e.target.value)}
            placeholder="sk-ant-..."
          />
        </div>
        <button className="btn btn-add-agent" onClick={addAgent}>
          + Agent
        </button>
      </header>

      <main className="app-main">
        <FileViewer metadataDB={metadataDB} fs={fs} />
        <div className="agent-panes">
          {agents.map((agent) => (
            <AgentPane
              key={agent.id}
              name={agent.name}
              apiKey={apiKey}
              fs={fs}
            />
          ))}
        </div>
      </main>
    </div>
  )
}
