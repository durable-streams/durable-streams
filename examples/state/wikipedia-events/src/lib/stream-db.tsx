import {
  Show,
  createContext,
  createSignal,
  onMount,
  useContext,
} from "solid-js"
import { createStateSchema, createStreamDB } from "@durable-streams/state"
import { wikipediaEventSchema } from "./types"
import type { JSX } from "solid-js"

const SERVER_URL = `http://localhost:4437`
const STREAM_PATH = `/wikipedia-events`

// State schema
export const stateSchema = createStateSchema({
  events: {
    schema: wikipediaEventSchema,
    type: `wikipedia-event`,
    primaryKey: `id`,
  },
})

// Context type
type WikipediaDB =
  | Awaited<ReturnType<typeof createStreamDB<typeof stateSchema>>>
  | undefined

const WikipediaDBContext = createContext<() => WikipediaDB>(undefined)

interface WikipediaDBProviderProps {
  children: JSX.Element
}

export function WikipediaDBProvider(props: WikipediaDBProviderProps) {
  const [db, setDb] = createSignal<WikipediaDB>(undefined)
  const [error, setError] = createSignal<string | undefined>(undefined)
  const [isLoading, setIsLoading] = createSignal(true)

  onMount(async () => {
    try {
      const streamUrl = `${SERVER_URL}/v1/stream${STREAM_PATH}`

      console.log(`[WikipediaDB] Connecting to stream...`)

      // Check if stream exists, create if not
      try {
        const { DurableStream } = await import(`@durable-streams/client`)
        const testStream = new DurableStream({ url: streamUrl })
        await testStream.head()
        console.log(`[WikipediaDB] Stream exists`)
      } catch {
        console.log(`[WikipediaDB] Stream not found, creating...`)
        const { DurableStream } = await import(`@durable-streams/client`)
        await DurableStream.create({
          url: streamUrl,
          contentType: `application/json`,
        })
        console.log(`[WikipediaDB] Stream created`)
      }

      const database = createStreamDB({
        streamOptions: {
          url: streamUrl,
          contentType: `application/json`,
        },
        state: stateSchema,
      })

      console.log(`[WikipediaDB] Preloading events...`)
      await database.preload()

      console.log(`[WikipediaDB] Connected and ready`)

      setDb(database)
      setIsLoading(false)
      console.log(`[WikipediaDB] Setup complete`)
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : `Failed to connect to stream`
      console.error(
        `[WikipediaDB] Connection error caught in onMount:`,
        errorMessage
      )
      console.error(`[WikipediaDB] Full error:`, err)
      console.error(
        `[WikipediaDB] Stack:`,
        err instanceof Error ? err.stack : `no stack`
      )
      setError(errorMessage)
      setIsLoading(false)
    }
  })

  return (
    <WikipediaDBContext.Provider value={db}>
      <Show when={!isLoading()} fallback={<LoadingState />}>
        <Show
          when={!error()}
          fallback={<ErrorState error={error() as string} />}
        >
          {props.children}
        </Show>
      </Show>
    </WikipediaDBContext.Provider>
  )
}

export function useWikipediaDB() {
  const context = useContext(WikipediaDBContext)
  if (!context) {
    throw new Error(`useWikipediaDB must be used within WikipediaDBProvider`)
  }
  const db = context()
  if (!db) {
    throw new Error(`WikipediaDB not initialized`)
  }
  return db
}

function LoadingState() {
  return (
    <div
      style={{
        display: `flex`,
        "align-items": `center`,
        "justify-content": `center`,
        height: `100vh`,
        "font-family": `system-ui, sans-serif`,
        background: `linear-gradient(135deg, #667eea 0%, #764ba2 100%)`,
        color: `white`,
      }}
    >
      <div style={{ "text-align": `center` }}>
        <div
          class="spinner"
          style={{
            display: `inline-block`,
            width: `40px`,
            height: `40px`,
            border: `4px solid rgba(255, 255, 255, 0.3)`,
            "border-radius": `50%`,
            "border-top-color": `white`,
            animation: `spin 1s linear infinite`,
            "margin-bottom": `1rem`,
          }}
        />
        <div style={{ "font-size": `1.2rem` }}>
          Connecting to Wikipedia EventStreams...
        </div>
      </div>
      <style>
        {`
          @keyframes spin {
            to { transform: rotate(360deg); }
          }
        `}
      </style>
    </div>
  )
}

function ErrorState(props: { error: string }) {
  return (
    <div
      style={{
        display: `flex`,
        "align-items": `center`,
        "justify-content": `center`,
        height: `100vh`,
        "font-family": `system-ui, sans-serif`,
        background: `linear-gradient(135deg, #667eea 0%, #764ba2 100%)`,
        color: `white`,
      }}
    >
      <div
        style={{
          "text-align": `center`,
          "max-width": `600px`,
          padding: `2rem`,
        }}
      >
        <div style={{ "font-size": `3rem`, "margin-bottom": `1rem` }}>❌</div>
        <h1 style={{ "margin-bottom": `1rem` }}>Connection Failed</h1>
        <p style={{ "margin-bottom": `1rem`, opacity: `0.9` }}>{props.error}</p>
        <div style={{ "font-size": `0.9rem`, opacity: `0.8` }}>
          <p>Make sure:</p>
          <ul style={{ "text-align": `left`, "margin-top": `0.5rem` }}>
            <li>The DurableStream server is running on {SERVER_URL}</li>
            <li>The Wikipedia worker is running</li>
            <li>The stream exists at {STREAM_PATH}</li>
          </ul>
        </div>
      </div>
    </div>
  )
}
