import { useCallback, useEffect, useState } from 'react';
import type { CrosswordGrid, PlacedWord } from './lib/crossword-generator';
import { generateCrossword } from './lib/crossword-generator';
import { WORD_DATABASE } from './lib/word-database';
import { gameStore } from './lib/game-store';
import { CrosswordGridComponent } from './components/CrosswordGrid';
import { CluesPanel } from './components/CluesPanel';
import { Leaderboard } from './components/Leaderboard';
import './App.css';

function App() {
  const [grid, setGrid] = useState<CrosswordGrid | null>(null);
  const [selectedWord, setSelectedWord] = useState<PlacedWord | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationProgress, setGenerationProgress] = useState(0);
  const [playerName, setPlayerName] = useState(gameStore.getCurrentPlayer().name);
  const [showSettings, setShowSettings] = useState(false);

  // Load existing game on mount
  useEffect(() => {
    const state = gameStore.getState();
    if (state.grid) {
      setGrid(state.grid);
    }

    const unsubscribe = gameStore.subscribe(() => {
      const newState = gameStore.getState();
      if (newState.grid !== grid) {
        setGrid(newState.grid);
      }
      setIsGenerating(newState.isGenerating);
      setGenerationProgress(newState.generationProgress);
    });

    return unsubscribe;
  }, []);

  const handleGenerateNew = useCallback(async () => {
    setIsGenerating(true);
    setGenerationProgress(0);
    gameStore.setGenerating(true, 0);

    try {
      const newGrid = await generateCrossword(WORD_DATABASE, {
        targetWords: 10000,
        maxAttempts: 500000,
        minWordLength: 3,
        maxWordLength: 15,
        progressCallback: (placed, total) => {
          const progress = Math.round((placed / total) * 100);
          setGenerationProgress(progress);
          gameStore.setGenerating(true, progress);
        },
      });

      setGrid(newGrid);
      gameStore.setGrid(newGrid);
      setSelectedWord(null);
    } catch (error) {
      console.error('Failed to generate crossword:', error);
      alert('Failed to generate crossword. Please try again.');
    } finally {
      setIsGenerating(false);
      gameStore.setGenerating(false, 100);
    }
  }, []);

  const handleSelectWord = useCallback((word: PlacedWord | null) => {
    setSelectedWord(word);
  }, []);

  const handleSavePlayerName = useCallback(() => {
    gameStore.setPlayerName(playerName);
    setShowSettings(false);
  }, [playerName]);

  const handleResetGame = useCallback(() => {
    if (confirm('Are you sure you want to reset the game? All progress will be lost.')) {
      gameStore.resetGame();
    }
  }, []);

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-left">
          <h1>Massive Multiplayer Crossword</h1>
          <span className="header-subtitle">
            {grid ? `${grid.words.length.toLocaleString()} words` : 'No puzzle loaded'}
          </span>
        </div>
        <div className="header-right">
          <button
            className="header-button"
            onClick={() => setShowSettings(!showSettings)}
          >
            Settings
          </button>
          <button
            className="header-button primary"
            onClick={handleGenerateNew}
            disabled={isGenerating}
          >
            {isGenerating ? `Generating... ${generationProgress}%` : 'New Puzzle'}
          </button>
        </div>
      </header>

      {showSettings && (
        <div className="settings-overlay" onClick={() => setShowSettings(false)}>
          <div className="settings-panel" onClick={e => e.stopPropagation()}>
            <h2>Settings</h2>
            <div className="settings-field">
              <label>Your Name</label>
              <input
                type="text"
                value={playerName}
                onChange={e => setPlayerName(e.target.value)}
                placeholder="Enter your name"
              />
            </div>
            <div className="settings-field">
              <label>Your Color</label>
              <div className="color-picker">
                {['#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7', '#DDA0DD', '#F7DC6F', '#BB8FCE'].map(color => (
                  <button
                    key={color}
                    className={`color-option ${gameStore.getCurrentPlayer().color === color ? 'selected' : ''}`}
                    style={{ backgroundColor: color }}
                    onClick={() => gameStore.setPlayerColor(color)}
                  />
                ))}
              </div>
            </div>
            <div className="settings-actions">
              <button onClick={handleSavePlayerName}>Save</button>
              <button className="danger" onClick={handleResetGame}>Reset Game</button>
            </div>
          </div>
        </div>
      )}

      {isGenerating && (
        <div className="generating-overlay">
          <div className="generating-modal">
            <div className="spinner" />
            <h2>Generating Massive Crossword</h2>
            <p>Creating a puzzle with 10,000 words...</p>
            <div className="generation-progress">
              <div
                className="generation-progress-bar"
                style={{ width: `${generationProgress}%` }}
              />
            </div>
            <span className="generation-percent">{generationProgress}%</span>
          </div>
        </div>
      )}

      <main className="app-main">
        <Leaderboard />

        {grid ? (
          <>
            <CrosswordGridComponent
              grid={grid}
              selectedWord={selectedWord}
              onSelectWord={handleSelectWord}
            />
            <CluesPanel
              grid={grid}
              selectedWord={selectedWord}
              onSelectWord={handleSelectWord}
            />
          </>
        ) : (
          <div className="no-puzzle">
            <div className="no-puzzle-content">
              <h2>Welcome to Massive Multiplayer Crossword!</h2>
              <p>
                Collaborate with other players to solve a massive crossword puzzle
                with thousands of words from multiple languages and topics.
              </p>
              <ul>
                <li>10,000 words and clues</li>
                <li>Multiple languages: English, Spanish, French, German, Italian, Japanese, and more</li>
                <li>Topics include science, technology, food, animals, geography, and more</li>
                <li>Real-time multiplayer: see other players' guesses live</li>
                <li>Compete for the highest score</li>
              </ul>
              <button className="generate-button" onClick={handleGenerateNew}>
                Generate New Puzzle
              </button>
            </div>
          </div>
        )}
      </main>

      <footer className="app-footer">
        <p>
          Use arrow keys to navigate, type letters to fill cells, Tab to switch direction.
          Click a cell to select it.
        </p>
      </footer>
    </div>
  );
}

export default App;
