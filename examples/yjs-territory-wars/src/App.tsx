import { useEffect, useState } from "react"
import {
  ServerEndpointProvider,
  useServerEndpoint,
} from "./components/server-endpoint-context"
import { RegistryProvider } from "./components/registry-context"
import { Lobby } from "./components/Lobby"
import { GameRoom } from "./components/GameRoom"

const ADJECTIVES = [
  `Swift`,
  `Bold`,
  `Sly`,
  `Keen`,
  `Cool`,
  `Neon`,
  `Rad`,
  `Zen`,
]
const ANIMALS = [`Fox`, `Wolf`, `Hawk`, `Bear`, `Lynx`, `Crow`, `Stag`, `Hare`]

function randomName(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]
  const animal = ANIMALS[Math.floor(Math.random() * ANIMALS.length)]
  return `${adj} ${animal}`
}

function getInitialName(): string {
  return localStorage.getItem(`territory-player-name`) || randomName()
}

function useHashRoute(): string | null {
  const [roomId, setRoomId] = useState<string | null>(() => {
    const match = window.location.hash.match(/^#room\/(.+)$/)
    return match ? decodeURIComponent(match[1]) : null
  })

  useEffect(() => {
    const onHashChange = () => {
      const match = window.location.hash.match(/^#room\/(.+)$/)
      setRoomId(match ? decodeURIComponent(match[1]) : null)
    }
    window.addEventListener(`hashchange`, onHashChange)
    return () => window.removeEventListener(`hashchange`, onHashChange)
  }, [])

  return roomId
}

function AppInner() {
  const roomId = useHashRoute()
  const { yjsEndpoint, yjsHeaders } = useServerEndpoint()
  const [playerName, setPlayerName] = useState(getInitialName)

  const handleNameChange = (name: string) => {
    setPlayerName(name)
    // Only persist if the user manually changed it
    localStorage.setItem(`territory-player-name`, name)
  }

  if (roomId) {
    return (
      <GameRoom
        roomId={roomId}
        yjsBaseUrl={yjsEndpoint}
        yjsHeaders={yjsHeaders}
        playerName={playerName}
        onLeave={() => {
          window.location.hash = ``
        }}
      />
    )
  }

  return (
    <Lobby
      playerName={playerName}
      onPlayerNameChange={handleNameChange}
      onJoinRoom={(id) => {
        window.location.hash = `room/${encodeURIComponent(id)}`
      }}
    />
  )
}

export function App() {
  return (
    <ServerEndpointProvider>
      <RegistryProvider>
        <AppInner />
      </RegistryProvider>
    </ServerEndpointProvider>
  )
}
