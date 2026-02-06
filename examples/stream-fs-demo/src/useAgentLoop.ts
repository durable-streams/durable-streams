import { useCallback, useEffect, useRef, useState } from "react"
import Anthropic from "@anthropic-ai/sdk"
import {
  handleTool,
  isStreamFsTool,
  streamFsTools,
} from "@durable-streams/stream-fs"
import type { DurableFilesystem, ToolInput } from "@durable-streams/stream-fs"

export type LogEntryType =
  | `user`
  | `assistant`
  | `tool_call`
  | `tool_result`
  | `error`
  | `done`
  | `fs_event`

export interface LogEntry {
  id: number
  type: LogEntryType
  content: string
  detail?: string
  timestamp: number
}

function buildSystemPrompt(name: string) {
  return `You are "${name}", an AI agent with access to a shared filesystem. Other agents are also connected to this same filesystem and may be working on their own tasks concurrently.

Use the provided tools to complete the user's task.

You may receive notifications about filesystem changes made by other agents. When you see these:
- Only take action if the changes are relevant to your current task
- If you just performed the action yourself, say "noted" and stop
- You can read files created by other agents to coordinate

Be concise. Prefer tool actions over explanations.`
}

const MAX_AUTO_TRIGGERS = 5
const SELF_WRITE_FILTER_MS = 10000

export function useAgentLoop(
  name: string,
  apiKey: string,
  fs: DurableFilesystem | null
) {
  const [log, setLog] = useState<Array<LogEntry>>([])
  const [running, setRunning] = useState(false)
  const ready = fs !== null

  const nextIdRef = useRef(0)
  const messagesRef = useRef<Array<Anthropic.MessageParam>>([])
  const abortRef = useRef<AbortController | null>(null)
  const runningRef = useRef(false)
  const loopGenRef = useRef(0)
  const fsRef = useRef<DurableFilesystem | null>(fs)
  fsRef.current = fs
  const recentWritesRef = useRef<Map<string, number>>(new Map())
  const autoTriggerCountRef = useRef(0)
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingEventsRef = useRef<Array<{ eventType: string; path: string }>>(
    []
  )
  const hasTaskRef = useRef(false)

  // Stable refs for values used in callbacks
  const apiKeyRef = useRef(apiKey)
  apiKeyRef.current = apiKey

  const addLog = useCallback(
    (type: LogEntryType, content: string, detail?: string): void => {
      const entry: LogEntry = {
        id: nextIdRef.current++,
        type,
        content,
        detail,
        timestamp: Date.now(),
      }
      setLog((prev) => [...prev, entry])
    },
    []
  )

  // Ref-based addLog for use in non-React callbacks (watcher, timers)
  const addLogRef = useRef(addLog)
  addLogRef.current = addLog

  const executeLoop = useCallback(
    async (messages: Array<Anthropic.MessageParam>) => {
      const currentFs = fsRef.current
      const key = apiKeyRef.current
      if (!currentFs || !key) return

      const gen = loopGenRef.current
      setRunning(true)
      runningRef.current = true
      const abort = new AbortController()
      abortRef.current = abort

      const client = new Anthropic({
        apiKey: key,
        dangerouslyAllowBrowser: true,
      })

      try {
        let currentMessages = [...messages]

        while (!abort.signal.aborted) {
          const response = await client.messages.create(
            {
              model: `claude-sonnet-4-5-20250929`,
              max_tokens: 4096,
              system: buildSystemPrompt(name),
              tools: streamFsTools,
              messages: currentMessages,
            },
            {
              signal: abort.signal,
              headers: {
                "anthropic-dangerous-direct-browser-access": `true`,
              },
            }
          )

          const toolResults: Array<{
            type: `tool_result`
            tool_use_id: string
            content: string
          }> = []

          for (const block of response.content) {
            if (block.type === `text` && block.text.trim()) {
              addLogRef.current(`assistant`, block.text)
            } else if (block.type === `tool_use`) {
              addLogRef.current(
                `tool_call`,
                block.name,
                JSON.stringify(block.input, null, 2)
              )

              // Track writes for self-event filtering
              const input = block.input as Record<string, unknown>
              if (
                [
                  `write_file`,
                  `create_file`,
                  `delete_file`,
                  `edit_file`,
                  `mkdir`,
                  `rmdir`,
                ].includes(block.name)
              ) {
                recentWritesRef.current.set(input.path as string, Date.now())
              }

              if (isStreamFsTool(block.name)) {
                const result = await handleTool(
                  currentFs,
                  block.name,
                  block.input as ToolInput
                )
                const resultStr = result.success
                  ? JSON.stringify(result.result)
                  : `Error: ${result.error}`
                addLogRef.current(
                  `tool_result`,
                  result.success ? `\u2713 ${resultStr}` : `\u2717 ${resultStr}`
                )
                toolResults.push({
                  type: `tool_result`,
                  tool_use_id: block.id,
                  content: JSON.stringify(result),
                })
              }
            }
          }

          currentMessages = [
            ...currentMessages,
            { role: `assistant`, content: response.content },
          ]

          if (toolResults.length > 0) {
            currentMessages = [
              ...currentMessages,
              { role: `user`, content: toolResults },
            ]
            messagesRef.current = currentMessages
            continue
          }

          messagesRef.current = currentMessages
          addLogRef.current(`done`, `Finished`)
          break
        }
      } catch (err: unknown) {
        if (err instanceof Error && err.name !== `AbortError`) {
          addLogRef.current(`error`, err.message || String(err))
        }
      } finally {
        // Only reset if this is still the active generation
        if (loopGenRef.current === gen) {
          setRunning(false)
          runningRef.current = false
        }
        abortRef.current = null
      }
    },
    []
  )

  const executeLoopRef = useRef(executeLoop)
  executeLoopRef.current = executeLoop

  const triggerFromEvents = useCallback(
    (events: Array<{ eventType: string; path: string }>) => {
      if (autoTriggerCountRef.current >= MAX_AUTO_TRIGGERS) {
        addLogRef.current(
          `fs_event`,
          `Auto-response paused (${events.length} events) \u2014 send a message to resume`
        )
        return
      }

      autoTriggerCountRef.current++

      const eventText = events
        .map((e) => `${e.eventType}: ${e.path}`)
        .join(`, `)
      addLogRef.current(`fs_event`, eventText)

      const message = `[Filesystem changes detected: ${eventText}]\nRespond only if relevant to your task.`

      const messages: Array<Anthropic.MessageParam> = [
        ...messagesRef.current,
        { role: `user`, content: message },
      ]
      messagesRef.current = messages
      executeLoopRef.current(messages)
    },
    []
  )

  const triggerFromEventsRef = useRef(triggerFromEvents)
  triggerFromEventsRef.current = triggerFromEvents

  // Attach watcher to the shared filesystem
  useEffect(() => {
    if (!fs) return
    let cancelled = false

    const watcher = fs.watch()
    watcher.on(`all`, (eventType, path) => {
      if (cancelled) return

      // Filter out self-caused events
      const writeTime = recentWritesRef.current.get(path)
      if (writeTime && Date.now() - writeTime < SELF_WRITE_FILTER_MS) return

      // Only inject events if agent has been given a task and is idle
      if (runningRef.current || !hasTaskRef.current) return

      pendingEventsRef.current.push({ eventType, path })

      if (debounceTimerRef.current !== null) {
        clearTimeout(debounceTimerRef.current)
      }

      debounceTimerRef.current = setTimeout(() => {
        const events = [...pendingEventsRef.current]
        pendingEventsRef.current = []
        debounceTimerRef.current = null
        if (events.length > 0) {
          triggerFromEventsRef.current(events)
        }
      }, 1500)
    })

    return () => {
      cancelled = true
      watcher.close()
      if (debounceTimerRef.current !== null) {
        clearTimeout(debounceTimerRef.current)
      }
    }
  }, [fs])

  const start = useCallback(
    async (prompt: string) => {
      if (abortRef.current) {
        abortRef.current.abort()
      }
      loopGenRef.current++
      runningRef.current = false

      autoTriggerCountRef.current = 0
      hasTaskRef.current = true
      addLog(`user`, prompt)
      const messages: Array<Anthropic.MessageParam> = [
        ...messagesRef.current,
        { role: `user`, content: prompt },
      ]
      messagesRef.current = messages
      await executeLoop(messages)
    },
    [addLog, executeLoop]
  )

  const stop = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  const clearLog = useCallback(() => {
    setLog([])
    messagesRef.current = []
    autoTriggerCountRef.current = 0
    hasTaskRef.current = false
  }, [])

  return { log, running, ready, start, stop, clearLog }
}
