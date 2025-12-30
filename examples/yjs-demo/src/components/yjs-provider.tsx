import { createContext, useContext, useEffect, useRef, useState } from "react"
import * as Y from "yjs"
import { Awareness } from "y-protocols/awareness"
import { DurableStreamsProvider } from "@durable-streams/y-durable-streams"
import { useServerEndpoint } from "./server-endpoint-context"
import type { ReactNode } from "react"
import type { ProviderStatus } from "@durable-streams/y-durable-streams"

// ============================================================================
// User colors for presence
// ============================================================================

const USER_COLORS = [
  { color: `#30bced`, light: `#30bced33` },
  { color: `#6eeb83`, light: `#6eeb8333` },
  { color: `#ffbc42`, light: `#ffbc4233` },
  { color: `#ecd444`, light: `#ecd44433` },
  { color: `#ee6352`, light: `#ee635233` },
  { color: `#9ac2c9`, light: `#9ac2c933` },
  { color: `#8acb88`, light: `#8acb8833` },
  { color: `#1be7ff`, light: `#1be7ff33` },
]

function getRandomColor() {
  return USER_COLORS[Math.floor(Math.random() * USER_COLORS.length)]
}

// ============================================================================
// React Context
// ============================================================================

interface YjsRoomContextValue {
  doc: Y.Doc
  awareness: Awareness
  roomId: string
  isLoading: boolean
  isSynced: boolean
  error: Error | null
  setUsername: (name: string) => void
  username: string
}

const YjsRoomContext = createContext<YjsRoomContextValue | null>(null)

export function useYjsRoom(): YjsRoomContextValue {
  const context = useContext(YjsRoomContext)
  if (!context) {
    throw new Error(`useYjsRoom must be used within a YjsRoomProvider`)
  }
  return context
}

// ============================================================================
// React Provider Component
// ============================================================================

interface YjsRoomProviderProps {
  roomId: string
  children: ReactNode
}

// Generate random user info on each page load (not persisted)
function generateUserInfo(): {
  name: string
  color: { color: string; light: string }
} {
  const adjectives = [
    `Happy`,
    `Clever`,
    `Swift`,
    `Bright`,
    `Calm`,
    `Bold`,
    `Kind`,
    `Wise`,
  ]
  const animals = [
    `Panda`,
    `Fox`,
    `Owl`,
    `Bear`,
    `Wolf`,
    `Eagle`,
    `Tiger`,
    `Dolphin`,
  ]

  const adj = adjectives[Math.floor(Math.random() * adjectives.length)]
  const animal = animals[Math.floor(Math.random() * animals.length)]

  return {
    name: `${adj} ${animal}`,
    color: getRandomColor(),
  }
}

export function YjsRoomProvider({
  roomId,
  children,
}: YjsRoomProviderProps): ReactNode {
  const { serverEndpoint } = useServerEndpoint()
  const [userInfo] = useState(() => generateUserInfo())
  const [username, setUsernameState] = useState(() => userInfo.name)

  // Create doc and awareness with initial local state set synchronously
  const [{ doc, awareness }] = useState(() => {
    const newDoc = new Y.Doc()
    const newAwareness = new Awareness(newDoc)

    console.log(
      `[yjs-provider] Creating awareness, clientID:`,
      newAwareness.clientID
    )

    // Set initial awareness state synchronously before provider connects
    // NOTE: Must use setLocalState (not setLocalStateField) because a new
    // Awareness instance starts with null state, and setLocalStateField
    // only works if there's already a state object.
    const initialState = {
      user: {
        name: userInfo.name,
        color: userInfo.color.color,
        colorLight: userInfo.color.light,
      },
    }
    newAwareness.setLocalState(initialState)

    return { doc: newDoc, awareness: newAwareness }
  })

  const [isLoading, setIsLoading] = useState(true)
  const [isSynced, setIsSynced] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const providerRef = useRef<DurableStreamsProvider | null>(null)
  const usernameRef = useRef(username)
  usernameRef.current = username

  const setUsername = (name: string) => {
    setUsernameState(name)
    // Update the user field in awareness state
    const currentState = awareness.getLocalState() || {}
    awareness.setLocalState({
      ...currentState,
      user: {
        name,
        color: userInfo.color.color,
        colorLight: userInfo.color.light,
      },
    })
  }

  useEffect(() => {
    const documentStreamUrl = `${serverEndpoint}/v1/stream/rooms/${roomId}`
    const presenceStreamUrl = `${serverEndpoint}/v1/stream/presence/${roomId}`

    const provider = new DurableStreamsProvider({
      doc,
      documentStream: {
        url: documentStreamUrl,
      },
      awarenessStream: {
        url: presenceStreamUrl,
        protocol: awareness,
      },
      connect: false, // We'll connect manually after setting up listeners
    })

    provider.on(`synced`, (synced) => {
      setIsSynced(synced)
      if (synced) {
        setIsLoading(false)
      }
    })

    provider.on(`status`, (status: ProviderStatus) => {
      if (status === `connected`) {
        setIsLoading(false)
      }
    })

    provider.on(`error`, (err) => {
      setError(err)
      setIsLoading(false)
    })

    // Re-set awareness state right before connecting
    // This is needed because React Strict Mode's cleanup may have cleared it
    // when destroying the previous provider instance
    if (awareness.getLocalState() === null) {
      awareness.setLocalState({
        user: {
          name: usernameRef.current,
          color: userInfo.color.color,
          colorLight: userInfo.color.light,
        },
      })
    }

    providerRef.current = provider
    provider.connect()

    return () => {
      provider.destroy()
      providerRef.current = null
    }
  }, [roomId, doc, awareness, serverEndpoint, userInfo])

  const value: YjsRoomContextValue = {
    doc,
    awareness,
    roomId,
    isLoading,
    isSynced,
    error,
    setUsername,
    username,
  }

  return (
    <YjsRoomContext.Provider value={value}>{children}</YjsRoomContext.Provider>
  )
}
