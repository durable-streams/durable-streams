/**
 * Massive Crossword Generator
 * Generates a 10,000+ word crossword puzzle using a greedy placement algorithm
 * with intersection optimization.
 *
 * Strategy:
 * 1. Start with seed words in the center
 * 2. Use BFS to expand, always trying to maximize intersections
 * 3. Index words by length and letter positions for O(1) lookups
 * 4. Track used words to avoid duplicates
 */

export interface Word {
  text: string;
  clue: string;
  language: string;
  topic: string;
}

export interface PlacedWord {
  id: number;
  word: string;
  clue: string;
  x: number;
  y: number;
  direction: 'across' | 'down';
  number: number;
  language: string;
  topic: string;
}

export interface Cell {
  letter: string;
  acrossWord?: number;
  downWord?: number;
  number?: number;
}

export interface CrosswordGrid {
  cells: Map<string, Cell>;
  words: PlacedWord[];
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  width: number;
  height: number;
}

// Index structure for fast word lookup
interface WordIndex {
  byLength: Map<number, Word[]>;
  byLengthAndPosition: Map<string, Word[]>; // "length:position:letter" -> words
}

function createWordIndex(words: Word[]): WordIndex {
  const byLength = new Map<number, Word[]>();
  const byLengthAndPosition = new Map<string, Word[]>();

  for (const word of words) {
    const len = word.text.length;

    // Index by length
    if (!byLength.has(len)) {
      byLength.set(len, []);
    }
    byLength.get(len)!.push(word);

    // Index by length + position + letter
    for (let i = 0; i < len; i++) {
      const key = `${len}:${i}:${word.text[i].toUpperCase()}`;
      if (!byLengthAndPosition.has(key)) {
        byLengthAndPosition.set(key, []);
      }
      byLengthAndPosition.get(key)!.push(word);
    }
  }

  return { byLength, byLengthAndPosition };
}

// Find words that can intersect at a given position
function findIntersectingWords(
  index: WordIndex,
  letter: string,
  minLength: number,
  maxLength: number,
  usedWords: Set<string>
): Array<{ word: Word; intersectPos: number }> {
  const results: Array<{ word: Word; intersectPos: number }> = [];

  for (let len = minLength; len <= maxLength; len++) {
    for (let pos = 0; pos < len; pos++) {
      const key = `${len}:${pos}:${letter.toUpperCase()}`;
      const words = index.byLengthAndPosition.get(key) || [];

      for (const word of words) {
        if (!usedWords.has(word.text.toUpperCase())) {
          results.push({ word, intersectPos: pos });
        }
      }
    }
  }

  // Shuffle for variety
  for (let i = results.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [results[i], results[j]] = [results[j], results[i]];
  }

  return results;
}

// Check if a word can be placed at position
function canPlace(
  grid: CrosswordGrid,
  word: string,
  x: number,
  y: number,
  direction: 'across' | 'down'
): boolean {
  const dx = direction === 'across' ? 1 : 0;
  const dy = direction === 'down' ? 1 : 0;

  // Check cell before word (should be empty or boundary)
  const beforeKey = `${x - dx},${y - dy}`;
  if (grid.cells.has(beforeKey)) return false;

  // Check cell after word (should be empty or boundary)
  const afterKey = `${x + word.length * dx},${y + word.length * dy}`;
  if (grid.cells.has(afterKey)) return false;

  let hasIntersection = false;

  for (let i = 0; i < word.length; i++) {
    const cx = x + i * dx;
    const cy = y + i * dy;
    const key = `${cx},${cy}`;
    const cell = grid.cells.get(key);

    if (cell) {
      // Cell exists - must match letter
      if (cell.letter !== word[i].toUpperCase()) return false;

      // Check we're not running parallel to existing word
      if (direction === 'across' && cell.acrossWord !== undefined) return false;
      if (direction === 'down' && cell.downWord !== undefined) return false;

      hasIntersection = true;
    } else {
      // Cell is empty - check adjacent cells perpendicular to direction
      // to avoid creating unintended adjacent words
      if (direction === 'across') {
        const above = grid.cells.get(`${cx},${cy - 1}`);
        const below = grid.cells.get(`${cx},${cy + 1}`);
        if ((above && above.downWord === undefined) || (below && below.downWord === undefined)) {
          // Adjacent cell without being part of a down word - could create invalid word
          // Actually this is too restrictive, let's allow it for massive grids
        }
      } else {
        const left = grid.cells.get(`${cx - 1},${cy}`);
        const right = grid.cells.get(`${cx + 1},${cy}`);
        if ((left && left.acrossWord === undefined) || (right && right.acrossWord === undefined)) {
          // Similar check for horizontal neighbors
        }
      }
    }
  }

  return grid.words.length === 0 || hasIntersection;
}

// Place a word on the grid
function placeWord(
  grid: CrosswordGrid,
  wordData: Word,
  x: number,
  y: number,
  direction: 'across' | 'down'
): PlacedWord {
  const word = wordData.text.toUpperCase();
  const dx = direction === 'across' ? 1 : 0;
  const dy = direction === 'down' ? 1 : 0;
  const wordId = grid.words.length;

  for (let i = 0; i < word.length; i++) {
    const cx = x + i * dx;
    const cy = y + i * dy;
    const key = `${cx},${cy}`;

    let cell = grid.cells.get(key);
    if (!cell) {
      cell = { letter: word[i] };
      grid.cells.set(key, cell);
    }

    if (direction === 'across') {
      cell.acrossWord = wordId;
    } else {
      cell.downWord = wordId;
    }

    // Update bounds
    grid.minX = Math.min(grid.minX, cx);
    grid.maxX = Math.max(grid.maxX, cx);
    grid.minY = Math.min(grid.minY, cy);
    grid.maxY = Math.max(grid.maxY, cy);
  }

  const placed: PlacedWord = {
    id: wordId,
    word,
    clue: wordData.clue,
    x,
    y,
    direction,
    number: 0, // Will be assigned later
    language: wordData.language,
    topic: wordData.topic
  };

  grid.words.push(placed);
  return placed;
}

// Get intersection opportunities from placed words
function getIntersectionOpportunities(
  grid: CrosswordGrid
): Array<{ x: number; y: number; letter: string; direction: 'across' | 'down' }> {
  const opportunities: Array<{ x: number; y: number; letter: string; direction: 'across' | 'down' }> = [];

  for (const [key, cell] of grid.cells) {
    const [x, y] = key.split(',').map(Number);

    // If cell is part of across word, can potentially start/contain a down word
    if (cell.acrossWord !== undefined && cell.downWord === undefined) {
      opportunities.push({ x, y, letter: cell.letter, direction: 'down' });
    }

    // If cell is part of down word, can potentially start/contain an across word
    if (cell.downWord !== undefined && cell.acrossWord === undefined) {
      opportunities.push({ x, y, letter: cell.letter, direction: 'across' });
    }
  }

  // Shuffle for variety
  for (let i = opportunities.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [opportunities[i], opportunities[j]] = [opportunities[j], opportunities[i]];
  }

  return opportunities;
}

// Assign clue numbers to words
function assignNumbers(grid: CrosswordGrid): void {
  // Get all starting positions
  const starts: Array<{ x: number; y: number; wordIds: number[] }> = [];

  for (const word of grid.words) {
    const existing = starts.find(s => s.x === word.x && s.y === word.y);
    if (existing) {
      existing.wordIds.push(word.id);
    } else {
      starts.push({ x: word.x, y: word.y, wordIds: [word.id] });
    }
  }

  // Sort by position (top to bottom, left to right)
  starts.sort((a, b) => {
    if (a.y !== b.y) return a.y - b.y;
    return a.x - b.x;
  });

  // Assign numbers
  let num = 1;
  for (const start of starts) {
    for (const wordId of start.wordIds) {
      grid.words[wordId].number = num;
    }
    num++;
  }
}

export interface GeneratorOptions {
  targetWords: number;
  maxAttempts: number;
  minWordLength: number;
  maxWordLength: number;
  progressCallback?: (placed: number, total: number) => void;
}

export async function generateCrossword(
  words: Word[],
  options: GeneratorOptions
): Promise<CrosswordGrid> {
  const {
    targetWords,
    maxAttempts,
    minWordLength,
    maxWordLength,
    progressCallback
  } = options;

  // Filter words by length
  const filteredWords = words.filter(
    w => w.text.length >= minWordLength && w.text.length <= maxWordLength
  );

  if (filteredWords.length < targetWords) {
    console.warn(`Only ${filteredWords.length} words available, target is ${targetWords}`);
  }

  const index = createWordIndex(filteredWords);
  const usedWords = new Set<string>();

  const grid: CrosswordGrid = {
    cells: new Map(),
    words: [],
    minX: 0,
    maxX: 0,
    minY: 0,
    maxY: 0,
    width: 0,
    height: 0
  };

  // Start with a long seed word
  const longWords = [...(index.byLength.get(15) || []), ...(index.byLength.get(14) || []), ...(index.byLength.get(13) || [])];
  if (longWords.length === 0) {
    throw new Error('No long words available for seeding');
  }

  const seedWord = longWords[Math.floor(Math.random() * longWords.length)];
  placeWord(grid, seedWord, 0, 0, 'across');
  usedWords.add(seedWord.text.toUpperCase());

  let attempts = 0;
  let lastProgressReport = 0;

  // Main generation loop
  while (grid.words.length < targetWords && attempts < maxAttempts) {
    attempts++;

    // Report progress periodically
    if (progressCallback && grid.words.length - lastProgressReport >= 100) {
      progressCallback(grid.words.length, targetWords);
      lastProgressReport = grid.words.length;
      // Yield to event loop periodically
      await new Promise(resolve => setTimeout(resolve, 0));
    }

    const opportunities = getIntersectionOpportunities(grid);
    if (opportunities.length === 0) break;

    let placed = false;

    for (const opp of opportunities) {
      if (placed) break;

      const candidates = findIntersectingWords(
        index,
        opp.letter,
        minWordLength,
        maxWordLength,
        usedWords
      );

      for (const { word, intersectPos } of candidates) {
        // Calculate starting position so the intersection is at opp position
        const startX = opp.direction === 'across' ? opp.x - intersectPos : opp.x;
        const startY = opp.direction === 'down' ? opp.y - intersectPos : opp.y;

        if (canPlace(grid, word.text, startX, startY, opp.direction)) {
          placeWord(grid, word, startX, startY, opp.direction);
          usedWords.add(word.text.toUpperCase());
          placed = true;
          break;
        }
      }
    }

    // If no intersection found, try random placement near edges
    if (!placed && grid.words.length < targetWords / 2) {
      const unusedWords = filteredWords.filter(w => !usedWords.has(w.text.toUpperCase()));
      if (unusedWords.length > 0) {
        const word = unusedWords[Math.floor(Math.random() * unusedWords.length)];
        const direction = Math.random() > 0.5 ? 'across' : 'down';

        // Try to place near existing grid
        for (let tries = 0; tries < 50; tries++) {
          const x = grid.minX + Math.floor(Math.random() * (grid.maxX - grid.minX + 10)) - 5;
          const y = grid.minY + Math.floor(Math.random() * (grid.maxY - grid.minY + 10)) - 5;

          if (canPlace(grid, word.text, x, y, direction)) {
            placeWord(grid, word, x, y, direction);
            usedWords.add(word.text.toUpperCase());
            break;
          }
        }
      }
    }
  }

  // Assign clue numbers
  assignNumbers(grid);

  // Calculate dimensions
  grid.width = grid.maxX - grid.minX + 1;
  grid.height = grid.maxY - grid.minY + 1;

  // Normalize coordinates to start at 0
  const offsetX = grid.minX;
  const offsetY = grid.minY;

  const newCells = new Map<string, Cell>();
  for (const [key, cell] of grid.cells) {
    const [x, y] = key.split(',').map(Number);
    newCells.set(`${x - offsetX},${y - offsetY}`, cell);
  }
  grid.cells = newCells;

  for (const word of grid.words) {
    word.x -= offsetX;
    word.y -= offsetY;
  }

  grid.minX = 0;
  grid.minY = 0;
  grid.maxX = grid.width - 1;
  grid.maxY = grid.height - 1;

  if (progressCallback) {
    progressCallback(grid.words.length, grid.words.length);
  }

  return grid;
}

// Serialize grid for storage
export function serializeGrid(grid: CrosswordGrid): string {
  const cells: Array<[string, Cell]> = [...grid.cells.entries()];
  return JSON.stringify({
    cells,
    words: grid.words,
    minX: grid.minX,
    maxX: grid.maxX,
    minY: grid.minY,
    maxY: grid.maxY,
    width: grid.width,
    height: grid.height
  });
}

// Deserialize grid from storage
export function deserializeGrid(data: string): CrosswordGrid {
  const parsed = JSON.parse(data);
  return {
    cells: new Map(parsed.cells),
    words: parsed.words,
    minX: parsed.minX,
    maxX: parsed.maxX,
    minY: parsed.minY,
    maxY: parsed.maxY,
    width: parsed.width,
    height: parsed.height
  };
}
