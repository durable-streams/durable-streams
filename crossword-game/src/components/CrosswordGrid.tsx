import { useCallback, useEffect, useRef, useState } from 'react';
import type { CrosswordGrid as GridType, PlacedWord } from '../lib/crossword-generator';
import type { PlayerGuess } from '../lib/game-store';
import { gameStore } from '../lib/game-store';
import './CrosswordGrid.css';

interface Props {
  grid: GridType;
  selectedWord: PlacedWord | null;
  onSelectWord: (word: PlacedWord | null) => void;
}

interface CellData {
  letter: string;
  number?: number;
  x: number;
  y: number;
  isPartOfAcross: boolean;
  isPartOfDown: boolean;
}

export function CrosswordGridComponent({ grid, selectedWord, onSelectWord }: Props) {
  const [selectedCell, setSelectedCell] = useState<{ x: number; y: number } | null>(null);
  const [direction, setDirection] = useState<'across' | 'down'>('across');
  const [guesses, setGuesses] = useState<Map<string, PlayerGuess>>(new Map());
  const [viewOffset, setViewOffset] = useState({ x: 0, y: 0 });
  const [scale, setScale] = useState(1);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Subscribe to game store updates
  useEffect(() => {
    const unsubscribe = gameStore.subscribe(() => {
      setGuesses(new Map(gameStore.getState().guesses));
    });
    setGuesses(new Map(gameStore.getState().guesses));
    return unsubscribe;
  }, []);

  // Build cell map with number assignments
  const cellMap = new Map<string, CellData>();
  const numberMap = new Map<string, number>();

  // First pass: assign numbers
  const starts: Array<{ x: number; y: number; words: PlacedWord[] }> = [];
  for (const word of grid.words) {
    const key = `${word.x},${word.y}`;
    const existing = starts.find(s => `${s.x},${s.y}` === key);
    if (existing) {
      existing.words.push(word);
    } else {
      starts.push({ x: word.x, y: word.y, words: [word] });
    }
  }
  starts.sort((a, b) => a.y !== b.y ? a.y - b.y : a.x - b.x);
  starts.forEach((start, i) => {
    numberMap.set(`${start.x},${start.y}`, i + 1);
  });

  // Second pass: build cell data
  for (const [key, cell] of grid.cells) {
    const [x, y] = key.split(',').map(Number);
    cellMap.set(key, {
      letter: cell.letter,
      number: numberMap.get(key),
      x,
      y,
      isPartOfAcross: cell.acrossWord !== undefined,
      isPartOfDown: cell.downWord !== undefined,
    });
  }

  // Find word at cell
  const findWordAtCell = useCallback((x: number, y: number, preferredDirection: 'across' | 'down'): PlacedWord | null => {
    const wordsAtCell = grid.words.filter(word => {
      const dx = word.direction === 'across' ? 1 : 0;
      const dy = word.direction === 'down' ? 1 : 0;
      for (let i = 0; i < word.word.length; i++) {
        if (word.x + i * dx === x && word.y + i * dy === y) {
          return true;
        }
      }
      return false;
    });

    if (wordsAtCell.length === 0) return null;

    // Prefer the requested direction
    const preferred = wordsAtCell.find(w => w.direction === preferredDirection);
    return preferred || wordsAtCell[0];
  }, [grid]);

  // Handle cell click
  const handleCellClick = useCallback((x: number, y: number) => {
    const key = `${x},${y}`;
    const cell = cellMap.get(key);
    if (!cell) return;

    // If clicking same cell, toggle direction
    if (selectedCell?.x === x && selectedCell?.y === y) {
      const newDirection = direction === 'across' ? 'down' : 'across';
      setDirection(newDirection);
      const word = findWordAtCell(x, y, newDirection);
      onSelectWord(word);
    } else {
      setSelectedCell({ x, y });
      const word = findWordAtCell(x, y, direction);
      onSelectWord(word);
    }

    inputRef.current?.focus();
  }, [selectedCell, direction, cellMap, findWordAtCell, onSelectWord]);

  // Handle keyboard input
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!selectedCell) return;

    const { x, y } = selectedCell;
    const key = e.key.toUpperCase();

    if (key >= 'A' && key <= 'Z') {
      // Make a guess
      gameStore.makeGuess(x, y, key);

      // Move to next cell
      const dx = direction === 'across' ? 1 : 0;
      const dy = direction === 'down' ? 1 : 0;
      const nextKey = `${x + dx},${y + dy}`;
      if (cellMap.has(nextKey)) {
        setSelectedCell({ x: x + dx, y: y + dy });
      }
    } else if (e.key === 'Backspace' || e.key === 'Delete') {
      // Clear current cell and move back
      const dx = direction === 'across' ? 1 : 0;
      const dy = direction === 'down' ? 1 : 0;
      const prevKey = `${x - dx},${y - dy}`;
      if (cellMap.has(prevKey)) {
        setSelectedCell({ x: x - dx, y: y - dy });
      }
    } else if (e.key === 'ArrowRight') {
      const nextKey = `${x + 1},${y}`;
      if (cellMap.has(nextKey)) {
        setSelectedCell({ x: x + 1, y });
        if (direction !== 'across') setDirection('across');
      }
    } else if (e.key === 'ArrowLeft') {
      const nextKey = `${x - 1},${y}`;
      if (cellMap.has(nextKey)) {
        setSelectedCell({ x: x - 1, y });
        if (direction !== 'across') setDirection('across');
      }
    } else if (e.key === 'ArrowDown') {
      const nextKey = `${x},${y + 1}`;
      if (cellMap.has(nextKey)) {
        setSelectedCell({ x, y: y + 1 });
        if (direction !== 'down') setDirection('down');
      }
    } else if (e.key === 'ArrowUp') {
      const nextKey = `${x},${y - 1}`;
      if (cellMap.has(nextKey)) {
        setSelectedCell({ x, y: y - 1 });
        if (direction !== 'down') setDirection('down');
      }
    } else if (e.key === 'Tab') {
      e.preventDefault();
      setDirection(d => d === 'across' ? 'down' : 'across');
    }
  }, [selectedCell, direction, cellMap]);

  // Pan and zoom
  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      setScale(s => Math.min(Math.max(s * delta, 0.2), 3));
    } else {
      setViewOffset(offset => ({
        x: offset.x - e.deltaX,
        y: offset.y - e.deltaY,
      }));
    }
  }, []);

  // Calculate visible area
  const cellSize = 36 * scale;
  const visibleCells = Array.from(cellMap.values());

  // Check if cell is part of selected word
  const isCellInSelectedWord = (x: number, y: number): boolean => {
    if (!selectedWord) return false;
    const dx = selectedWord.direction === 'across' ? 1 : 0;
    const dy = selectedWord.direction === 'down' ? 1 : 0;
    for (let i = 0; i < selectedWord.word.length; i++) {
      if (selectedWord.x + i * dx === x && selectedWord.y + i * dy === y) {
        return true;
      }
    }
    return false;
  };

  return (
    <div
      ref={containerRef}
      className="crossword-container"
      onWheel={handleWheel}
      onClick={() => inputRef.current?.focus()}
    >
      {/* Hidden input for keyboard capture */}
      <input
        ref={inputRef}
        type="text"
        className="crossword-input"
        onKeyDown={handleKeyDown}
        autoFocus
      />

      <div
        className="crossword-grid"
        style={{
          transform: `translate(${viewOffset.x}px, ${viewOffset.y}px)`,
        }}
      >
        {visibleCells.map(cell => {
          const key = `${cell.x},${cell.y}`;
          const guess = guesses.get(key);
          const isSelected = selectedCell?.x === cell.x && selectedCell?.y === cell.y;
          const isInWord = isCellInSelectedWord(cell.x, cell.y);

          return (
            <div
              key={key}
              className={`crossword-cell ${isSelected ? 'selected' : ''} ${isInWord ? 'in-word' : ''} ${guess?.isCorrect ? 'correct' : guess ? 'incorrect' : ''}`}
              style={{
                left: cell.x * cellSize,
                top: cell.y * cellSize,
                width: cellSize,
                height: cellSize,
                fontSize: cellSize * 0.5,
                borderColor: guess?.playerColor,
                borderWidth: guess ? 2 : 1,
              }}
              onClick={() => handleCellClick(cell.x, cell.y)}
            >
              {cell.number && (
                <span className="cell-number" style={{ fontSize: cellSize * 0.25 }}>
                  {cell.number}
                </span>
              )}
              <span className="cell-letter">
                {guess?.letter || ''}
              </span>
              {guess && !guess.isCorrect && (
                <span
                  className="cell-player"
                  style={{
                    backgroundColor: guess.playerColor,
                    fontSize: cellSize * 0.2,
                  }}
                >
                  {guess.playerName.slice(0, 2)}
                </span>
              )}
            </div>
          );
        })}
      </div>

      <div className="zoom-controls">
        <button onClick={() => setScale(s => Math.min(s * 1.2, 3))}>+</button>
        <span>{Math.round(scale * 100)}%</span>
        <button onClick={() => setScale(s => Math.max(s * 0.8, 0.2))}>-</button>
        <button onClick={() => { setScale(1); setViewOffset({ x: 0, y: 0 }); }}>Reset</button>
      </div>
    </div>
  );
}
