import { createFileRoute } from "@tanstack/react-router"
import { ViewStateProvider } from "../hooks/useViewState"
import { Header } from "../components/layout/Header"
import { Footer } from "../components/layout/Footer"
import { GameCanvas } from "../components/game/GameCanvas"
import { WorldView } from "../components/game/WorldView"
import { ConnectionStatus } from "../components/ui/ConnectionStatus"
import { ErrorToast } from "../components/ui/ErrorToast"
import "../styles/game.css"

export const Route = createFileRoute(`/`)({
  component: GamePage,
})

function GamePage() {
  return (
    <ViewStateProvider>
      <div className="game-layout" data-testid="game-layout">
        <Header />
        <ConnectionStatus />
        <main className="game-main" data-testid="game-main">
          <GameCanvas />
          <WorldView />
        </main>
        <Footer />
        <ErrorToast />
      </div>
    </ViewStateProvider>
  )
}
