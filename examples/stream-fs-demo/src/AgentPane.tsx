import { useCallback, useState } from "react"
import { useFilesystem } from "./useFilesystem"
import type { WatchLogEntry } from "./useFilesystem"

interface AgentPaneProps {
  name: string
  baseUrl: string
  streamPrefix: string
}

export default function AgentPane({
  name,
  baseUrl,
  streamPrefix,
}: AgentPaneProps) {
  const {
    files,
    loading,
    error,
    selectedFile,
    content,
    dirty,
    conflict,
    watchLog,
    selectFile,
    createFile,
    saveFile,
    deleteFile,
    setContent,
    clearConflict,
  } = useFilesystem(baseUrl, streamPrefix)

  const [newFileName, setNewFileName] = useState(``)
  const [showNewFile, setShowNewFile] = useState(false)

  const handleCreateFile = useCallback(async () => {
    if (!newFileName.trim()) return
    const fileName = newFileName.trim().includes(`.`)
      ? newFileName.trim()
      : `${newFileName.trim()}.txt`
    await createFile(fileName, ``)
    setNewFileName(``)
    setShowNewFile(false)
  }, [newFileName, createFile])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === `Enter`) {
        handleCreateFile()
      } else if (e.key === `Escape`) {
        setShowNewFile(false)
        setNewFileName(``)
      }
    },
    [handleCreateFile]
  )

  if (loading) {
    return (
      <div className="agent-pane">
        <div className="agent-header">{name}</div>
        <div className="agent-loading">Connecting...</div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="agent-pane">
        <div className="agent-header">{name}</div>
        <div className="agent-error">{error}</div>
      </div>
    )
  }

  return (
    <div className="agent-pane">
      <div className="agent-header">{name}</div>
      <div className="agent-body">
        {/* File sidebar */}
        <div className="file-sidebar">
          <div className="file-list">
            {files.length === 0 && (
              <div className="file-empty">No files yet</div>
            )}
            {files.map((entry) => {
              const path = `/${entry.name}`
              return (
                <button
                  key={entry.name}
                  className={`file-item ${selectedFile === path ? `selected` : ``}`}
                  onClick={() => selectFile(path)}
                >
                  {entry.name}
                </button>
              )
            })}
          </div>
          {showNewFile ? (
            <div className="new-file-input">
              <input
                type="text"
                value={newFileName}
                onChange={(e) => setNewFileName(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="filename.txt"
                autoFocus
              />
              <button className="btn-sm" onClick={handleCreateFile}>
                OK
              </button>
              <button
                className="btn-sm btn-cancel"
                onClick={() => {
                  setShowNewFile(false)
                  setNewFileName(``)
                }}
              >
                &times;
              </button>
            </div>
          ) : (
            <button
              className="btn-new-file"
              onClick={() => setShowNewFile(true)}
            >
              + New File
            </button>
          )}
        </div>

        {/* Editor area */}
        <div className="editor-area">
          {selectedFile ? (
            <>
              <div className="editor-toolbar">
                <span className="editor-filename">
                  {selectedFile}
                  {dirty && <span className="dirty-indicator"> *</span>}
                </span>
                <div className="editor-actions">
                  <button
                    className="btn btn-save"
                    onClick={saveFile}
                    disabled={!dirty}
                  >
                    Save
                  </button>
                  <button className="btn btn-delete" onClick={deleteFile}>
                    Delete
                  </button>
                </div>
              </div>
              {conflict && (
                <div className="conflict-banner">
                  Conflict: file was modified by another agent.
                  <button className="btn-sm" onClick={clearConflict}>
                    Reload latest
                  </button>
                </div>
              )}
              <textarea
                className="editor-textarea"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                spellCheck={false}
              />
            </>
          ) : (
            <div className="editor-placeholder">
              Select a file or create a new one
            </div>
          )}
        </div>
      </div>

      {/* Watch event log */}
      <div className="watch-log">
        {watchLog.slice(0, 5).map((entry, i) => (
          <WatchLogItem key={`${entry.timestamp}-${i}`} entry={entry} />
        ))}
      </div>
    </div>
  )
}

function WatchLogItem({ entry }: { entry: WatchLogEntry }) {
  const labels: Record<string, string> = {
    add: `+`,
    change: `~`,
    unlink: `-`,
    addDir: `+D`,
    unlinkDir: `-D`,
  }
  const label = labels[entry.eventType] || entry.eventType
  const age = Math.round((Date.now() - entry.timestamp) / 1000)

  return (
    <span className={`watch-entry watch-${entry.eventType}`}>
      <span className="watch-label">{label}</span>
      {entry.path}
      {age > 0 && <span className="watch-age">{age}s</span>}
    </span>
  )
}
