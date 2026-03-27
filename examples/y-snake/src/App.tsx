import { useEffect, useState } from "react"
import {
  ServerEndpointProvider,
  useServerEndpoint,
} from "./components/server-endpoint-context"
import { RegistryProvider } from "./components/registry-context"
import { Lobby } from "./components/Lobby"
import { GameRoom } from "./components/GameRoom"
import type { GameType } from "./components/GameRoom"

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
const ANIMALS = [
  `Cobra`,
  `Viper`,
  `Mamba`,
  `Python`,
  `Adder`,
  `Asp`,
  `Boa`,
  `Racer`,
]

function randomName(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]
  const animal = ANIMALS[Math.floor(Math.random() * ANIMALS.length)]
  return `${adj} ${animal}`
}

function getOrCreateName(): string {
  const stored = localStorage.getItem(`snake-player-name`)
  if (stored) return stored
  const name = randomName()
  localStorage.setItem(`snake-player-name`, name)
  return name
}

// Hash-based routing: #snake/room/<roomId> or #territory/room/<roomId>
// Legacy support: #room/<roomId> (defaults to snake)
function parseHash(hash: string): {
  game: GameType | null
  roomId: string | null
} {
  // New format: #snake/room/<roomId> or #territory/room/<roomId>
  const newMatch = hash.match(/^#(snake|territory)\/room\/(.+)$/)
  if (newMatch) {
    return {
      game: newMatch[1] as GameType,
      roomId: decodeURIComponent(newMatch[2]),
    }
  }

  // Game selector: #snake or #territory (no room yet)
  const gameMatch = hash.match(/^#(snake|territory)$/)
  if (gameMatch) {
    return { game: gameMatch[1] as GameType, roomId: null }
  }

  // Legacy format: #room/<roomId> (default to snake)
  const legacyMatch = hash.match(/^#room\/(.+)$/)
  if (legacyMatch) {
    return { game: `snake`, roomId: decodeURIComponent(legacyMatch[1]) }
  }

  return { game: null, roomId: null }
}

function useHashRoute(): { game: GameType | null; roomId: string | null } {
  const [route, setRoute] = useState<{
    game: GameType | null
    roomId: string | null
  }>(() => parseHash(window.location.hash))

  useEffect(() => {
    const onHashChange = () => {
      setRoute(parseHash(window.location.hash))
    }
    window.addEventListener(`hashchange`, onHashChange)
    return () => window.removeEventListener(`hashchange`, onHashChange)
  }, [])

  return route
}

const SELECTOR_PALETTE = {
  bg: `#1b1b1f`,
  card: `#161618`,
  border: `#2e2e32`,
  text: `rgba(235,235,245,0.68)`,
  accent: `#d0bcff`,
  dim: `rgba(235,235,245,0.38)`,
}

function GameSelector() {
  return (
    <div
      style={{
        display: `flex`,
        flexDirection: `column`,
        alignItems: `center`,
        justifyContent: `center`,
        minHeight: `100dvh`,
        fontFamily: `'Press Start 2P', monospace`,
        background: SELECTOR_PALETTE.bg,
        color: SELECTOR_PALETTE.text,
        padding: 20,
      }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Press+Start+2P&display=swap');
        .game-card { transition: border-color 0.15s; }
        .game-card:hover { border-color: #d0bcff !important; }
        .game-card:active { opacity: 0.7; }
      `}</style>

      <div
        style={{
          fontSize: 16,
          letterSpacing: 4,
          color: SELECTOR_PALETTE.accent,
          marginBottom: 8,
        }}
      >
        DURABLE GAMES
      </div>
      <div
        style={{
          fontSize: 7,
          color: SELECTOR_PALETTE.dim,
          marginBottom: 32,
        }}
      >
        SELECT A GAME
      </div>

      <div
        style={{
          display: `flex`,
          flexDirection: `column`,
          gap: 12,
          width: `100%`,
          maxWidth: 340,
        }}
      >
        <div
          className="game-card"
          style={{
            background: SELECTOR_PALETTE.card,
            border: `1px solid ${SELECTOR_PALETTE.border}`,
            padding: 20,
            cursor: `pointer`,
            textAlign: `center`,
          }}
          onClick={() => {
            window.location.hash = `snake`
          }}
        >
          <div
            style={{
              fontSize: 12,
              color: SELECTOR_PALETTE.accent,
              marginBottom: 10,
              letterSpacing: 2,
            }}
          >
            SNAKE
          </div>
          <div
            style={{
              fontSize: 7,
              color: SELECTOR_PALETTE.dim,
              lineHeight: 1.8,
            }}
          >
            Classic snake with multiplayer. Eat food, avoid obstacles and other
            players.
          </div>
        </div>

        <div
          className="game-card"
          style={{
            background: SELECTOR_PALETTE.card,
            border: `1px solid ${SELECTOR_PALETTE.border}`,
            padding: 20,
            cursor: `pointer`,
            textAlign: `center`,
          }}
          onClick={() => {
            window.location.hash = `territory`
          }}
        >
          <div
            style={{
              fontSize: 12,
              color: SELECTOR_PALETTE.accent,
              marginBottom: 10,
              letterSpacing: 2,
            }}
          >
            TERRITORY WARS
          </div>
          <div
            style={{
              fontSize: 7,
              color: SELECTOR_PALETTE.dim,
              lineHeight: 1.8,
            }}
          >
            Claim cells by moving over them. First to 50% of the grid wins.
            Collisions stun both players.
          </div>
        </div>
      </div>
    </div>
  )
}

function AppInner() {
  const { game, roomId } = useHashRoute()
  const { yjsEndpoint, yjsHeaders } = useServerEndpoint()
  const [playerName, setPlayerName] = useState(getOrCreateName)

  const handleNameChange = (name: string) => {
    setPlayerName(name)
    localStorage.setItem(`snake-player-name`, name)
  }

  // In a game room
  if (game && roomId) {
    return (
      <GameRoom
        roomId={roomId}
        yjsBaseUrl={yjsEndpoint}
        yjsHeaders={yjsHeaders}
        playerName={playerName}
        game={game}
        onLeave={() => {
          window.location.hash = game
        }}
      />
    )
  }

  // Game selected but no room — show lobby
  if (game) {
    return (
      <Lobby
        playerName={playerName}
        onPlayerNameChange={handleNameChange}
        onJoinRoom={(id) => {
          window.location.hash = `${game}/room/${encodeURIComponent(id)}`
        }}
      />
    )
  }

  // No game selected — show game selector
  return <GameSelector />
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
