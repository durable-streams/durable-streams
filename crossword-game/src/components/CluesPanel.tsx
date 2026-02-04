import { useMemo, useEffect, useState } from 'react';
import type { CrosswordGrid, PlacedWord } from '../lib/crossword-generator';
import { gameStore } from '../lib/game-store';
import './CluesPanel.css';

interface Props {
  grid: CrosswordGrid;
  selectedWord: PlacedWord | null;
  onSelectWord: (word: PlacedWord) => void;
}

export function CluesPanel({ grid, selectedWord, onSelectWord }: Props) {
  const [filter, setFilter] = useState('');
  const [showCompleted, setShowCompleted] = useState(true);
  const [, forceUpdate] = useState({});

  // Subscribe to updates for word completion status
  useEffect(() => {
    const unsubscribe = gameStore.subscribe(() => forceUpdate({}));
    return unsubscribe;
  }, []);

  // Group words by direction and sort by number
  const { acrossClues, downClues } = useMemo(() => {
    const across = grid.words
      .filter(w => w.direction === 'across')
      .sort((a, b) => a.number - b.number);

    const down = grid.words
      .filter(w => w.direction === 'down')
      .sort((a, b) => a.number - b.number);

    return { acrossClues: across, downClues: down };
  }, [grid]);

  // Filter clues
  const filterClues = (clues: PlacedWord[]): PlacedWord[] => {
    return clues.filter(word => {
      const progress = gameStore.getWordProgress(word);

      // Filter by completion
      if (!showCompleted && progress.isComplete) return false;

      // Filter by search
      if (filter) {
        const searchLower = filter.toLowerCase();
        return (
          word.clue.toLowerCase().includes(searchLower) ||
          word.topic.toLowerCase().includes(searchLower) ||
          word.language.toLowerCase().includes(searchLower) ||
          word.number.toString().includes(filter)
        );
      }

      return true;
    });
  };

  const filteredAcross = filterClues(acrossClues);
  const filteredDown = filterClues(downClues);

  const renderClue = (word: PlacedWord) => {
    const progress = gameStore.getWordProgress(word);
    const isSelected = selectedWord?.id === word.id;

    return (
      <div
        key={word.id}
        className={`clue-item ${isSelected ? 'selected' : ''} ${progress.isComplete ? 'completed' : ''}`}
        onClick={() => onSelectWord(word)}
      >
        <span className="clue-number">{word.number}.</span>
        <div className="clue-content">
          <p className="clue-text">{word.clue}</p>
          <div className="clue-meta">
            <span className="clue-length">({word.word.length} letters)</span>
            {word.language !== 'english' && (
              <span className="clue-language">{word.language}</span>
            )}
            <span className="clue-topic">{word.topic}</span>
            {progress.correct > 0 && (
              <span className="clue-progress">
                {progress.correct}/{progress.total}
              </span>
            )}
          </div>
        </div>
        {progress.isComplete && <span className="clue-check">✓</span>}
      </div>
    );
  };

  return (
    <div className="clues-panel">
      <div className="clues-header">
        <h2>Clues</h2>
        <div className="clues-stats">
          {grid.words.length.toLocaleString()} words
        </div>
      </div>

      <div className="clues-filter">
        <input
          type="text"
          placeholder="Search clues..."
          value={filter}
          onChange={e => setFilter(e.target.value)}
        />
        <label className="filter-checkbox">
          <input
            type="checkbox"
            checked={showCompleted}
            onChange={e => setShowCompleted(e.target.checked)}
          />
          Show completed
        </label>
      </div>

      <div className="clues-sections">
        <div className="clues-section">
          <h3>
            Across
            <span className="section-count">
              ({filteredAcross.length})
            </span>
          </h3>
          <div className="clues-list">
            {filteredAcross.map(renderClue)}
          </div>
        </div>

        <div className="clues-section">
          <h3>
            Down
            <span className="section-count">
              ({filteredDown.length})
            </span>
          </h3>
          <div className="clues-list">
            {filteredDown.map(renderClue)}
          </div>
        </div>
      </div>
    </div>
  );
}
