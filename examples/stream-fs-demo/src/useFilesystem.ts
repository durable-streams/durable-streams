import { useCallback, useEffect, useRef, useState } from "react"
import {
  DurableFilesystem,
  PreconditionFailedError,
} from "@durable-streams/stream-fs"
import type { Entry, WatchEventType } from "@durable-streams/stream-fs"

export interface WatchLogEntry {
  eventType: WatchEventType
  path: string
  timestamp: number
}

export interface UseFilesystemReturn {
  files: Array<Entry>
  loading: boolean
  error: string | null
  selectedFile: string | null
  content: string
  dirty: boolean
  conflict: boolean
  watchLog: Array<WatchLogEntry>
  selectFile: (path: string) => Promise<void>
  createFile: (name: string, content: string) => Promise<void>
  saveFile: () => Promise<void>
  deleteFile: () => Promise<void>
  setContent: (content: string) => void
  clearConflict: () => Promise<void>
}

export function useFilesystem(
  baseUrl: string,
  streamPrefix: string
): UseFilesystemReturn {
  const fsRef = useRef<DurableFilesystem | null>(null)
  const [files, setFiles] = useState<Array<Entry>>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [content, setContent] = useState(``)
  const [dirty, setDirty] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [watchLog, setWatchLog] = useState<Array<WatchLogEntry>>([])

  const selectedFileRef = useRef(selectedFile)
  selectedFileRef.current = selectedFile

  const refreshFileList = useCallback(() => {
    const fs = fsRef.current
    if (!fs) return
    try {
      const entries = fs.list(`/`)
      setFiles(entries.filter((e) => e.type === `file`))
    } catch {
      // Directory may not exist yet during initialization
    }
  }, [])

  const refreshSelectedContent = useCallback(async () => {
    const fs = fsRef.current
    const path = selectedFileRef.current
    if (!fs || !path) return
    try {
      if (fs.exists(path)) {
        const text = await fs.readTextFile(path)
        setContent(text)
        setDirty(false)
        setConflict(false)
      } else {
        setSelectedFile(null)
        setContent(``)
        setDirty(false)
      }
    } catch {
      // File may have been deleted between check and read
    }
  }, [])

  // Initialize filesystem and start watching
  useEffect(() => {
    let cancelled = false
    const fs = new DurableFilesystem({ baseUrl, streamPrefix })
    fsRef.current = fs

    async function init() {
      try {
        await fs.initialize()
        if (cancelled) return
        refreshFileList()
        setLoading(false)

        // Start watching for changes
        const watcher = fs.watch()
        watcher.on(`all`, (eventType, path) => {
          if (cancelled) return

          setWatchLog((prev) => [
            { eventType, path, timestamp: Date.now() },
            ...prev.slice(0, 19),
          ])

          refreshFileList()

          // If the changed file is currently selected, refresh its content
          if (
            path === selectedFileRef.current &&
            (eventType === `change` || eventType === `unlink`)
          ) {
            refreshSelectedContent()
          }
        })
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err))
          setLoading(false)
        }
      }
    }

    init()

    return () => {
      cancelled = true
      fs.close()
      fsRef.current = null
    }
  }, [baseUrl, streamPrefix, refreshFileList, refreshSelectedContent])

  const selectFile = useCallback(async (path: string) => {
    const fs = fsRef.current
    if (!fs) return
    setSelectedFile(path)
    selectedFileRef.current = path
    try {
      const text = await fs.readTextFile(path)
      setContent(text)
      setDirty(false)
      setConflict(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  const createFile = useCallback(
    async (name: string, initialContent: string) => {
      const fs = fsRef.current
      if (!fs) return
      const path = `/${name}`
      try {
        await fs.createFile(path, initialContent)
        refreshFileList()
        await selectFile(path)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    },
    [refreshFileList, selectFile]
  )

  const saveFile = useCallback(async () => {
    const fs = fsRef.current
    const path = selectedFileRef.current
    if (!fs || !path) return
    try {
      await fs.writeFile(path, content)
      setDirty(false)
      setConflict(false)
    } catch (err) {
      if (err instanceof PreconditionFailedError) {
        setConflict(true)
      } else {
        setError(err instanceof Error ? err.message : String(err))
      }
    }
  }, [content])

  const deleteFile = useCallback(async () => {
    const fs = fsRef.current
    const path = selectedFileRef.current
    if (!fs || !path) return
    try {
      await fs.deleteFile(path)
      setSelectedFile(null)
      setContent(``)
      setDirty(false)
      refreshFileList()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [refreshFileList])

  const updateContent = useCallback((newContent: string) => {
    setContent(newContent)
    setDirty(true)
  }, [])

  const clearConflict = useCallback(async () => {
    setConflict(false)
    await refreshSelectedContent()
  }, [refreshSelectedContent])

  return {
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
    setContent: updateContent,
    clearConflict,
  }
}
