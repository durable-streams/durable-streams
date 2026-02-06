import { useCallback, useEffect, useRef, useState } from "react"
import { eq, useLiveQuery } from "@tanstack/react-db"
import type { DurableFilesystem } from "@durable-streams/stream-fs"
import type { MetadataDB } from "./useMetadataDB"

interface FileViewerProps {
  metadataDB: MetadataDB | null
  fs: DurableFilesystem | null
}

export default function FileViewer({ metadataDB, fs }: FileViewerProps) {
  if (!metadataDB) {
    return (
      <div className="file-viewer">
        <div className="file-viewer-header">Files</div>
        <div className="agent-loading">Connecting...</div>
      </div>
    )
  }

  return <FileViewerReady metadataDB={metadataDB} fs={fs} />
}

function FileViewerReady({
  metadataDB,
  fs,
}: {
  metadataDB: MetadataDB
  fs: DurableFilesystem | null
}) {
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [content, setContent] = useState(``)

  // Query file entries reactively via StreamDB
  // useLiveQuery subscribes during render, before any effects run.
  const { data: files = [] } = useLiveQuery((q) =>
    q
      .from({ metadata: metadataDB.collections.metadata })
      .where(({ metadata }) => eq(metadata.type, `file`))
      .orderBy(({ metadata }) => metadata.path, `asc`)
  )

  // Start the SSE consumer AFTER useLiveQuery has subscribed.
  useEffect(() => {
    metadataDB.preload().catch((err) => {
      console.error(`[FileViewer] preload failed:`, err)
    })
  }, [metadataDB])

  // Re-read content when selected file changes or file list updates
  const selectedFileRef = useRef(selectedFile)
  selectedFileRef.current = selectedFile

  useEffect(() => {
    if (!selectedFile || !fs) return
    let cancelled = false

    async function loadContent() {
      try {
        if (!fs || !selectedFileRef.current) return
        fs.evictFromCache(selectedFileRef.current)
        const text = await fs.readTextFile(selectedFileRef.current)
        if (!cancelled) setContent(text)
      } catch {
        if (!cancelled) setContent(`(failed to read)`)
      }
    }

    loadContent()
    return () => {
      cancelled = true
    }
  }, [selectedFile, files, fs])

  const selectFile = useCallback((path: string) => {
    setSelectedFile((prev) => (prev === path ? null : path))
  }, [])

  return (
    <div className="file-viewer">
      <div className="file-viewer-header">Files</div>
      <div className="file-viewer-body">
        <div className="fv-file-list">
          {files.length === 0 && <div className="file-empty">No files yet</div>}
          {files.map((file) => (
            <button
              key={file.path}
              className={`file-item ${selectedFile === file.path ? `selected` : ``}`}
              onClick={() => selectFile(file.path)}
            >
              {file.path.slice(1)}
            </button>
          ))}
        </div>

        <div className="fv-content">
          {selectedFile ? (
            <>
              <div className="fv-content-header">
                <span className="editor-filename">{selectedFile}</span>
              </div>
              <pre className="fv-content-body">{content}</pre>
            </>
          ) : (
            <div className="editor-placeholder">
              Select a file to view its contents
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
