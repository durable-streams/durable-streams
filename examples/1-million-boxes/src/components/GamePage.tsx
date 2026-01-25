import { ViewStateProvider } from "../hooks/useViewState"
import { Header } from "./layout/Header"
import { Footer } from "./layout/Footer"
import { GameCanvas } from "./game/GameCanvas"
import { WorldView } from "./game/WorldView"
import { ConnectionStatus } from "./ui/ConnectionStatus"
import { ErrorToast } from "./ui/ErrorToast"
import { BonusToast } from "./ui/BonusToast"
import { GameCompleteDialog } from "./ui/GameCompleteDialog"
import "../styles/game.css"

export function GamePage() {
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
        <BonusToast />
        <GameCompleteDialog />
      </div>
    </ViewStateProvider>
  )
}
