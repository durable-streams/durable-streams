import { createFileRoute } from "@tanstack/react-router"
import { Header } from "../components/layout/Header"
import { Footer } from "../components/layout/Footer"
import { GameCanvas } from "../components/game/GameCanvas"
import { WorldView } from "../components/game/WorldView"
import "../styles/game.css"

export const Route = createFileRoute(`/`)({
  component: GamePage,
})

function GamePage() {
  return (
    <div className="game-layout" data-testid="game-layout">
      <Header />
      <main className="game-main" data-testid="game-main">
        <GameCanvas />
        <WorldView />
      </main>
      <Footer />
    </div>
  )
}
