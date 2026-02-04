/**
 * Game state management for multiplayer crossword
 * Uses local storage for persistence and BroadcastChannel for multi-tab sync
 */

import type { CrosswordGrid, PlacedWord } from './crossword-generator';
import { deserializeGrid, serializeGrid } from './crossword-generator';

export interface PlayerGuess {
  id: string;
  playerId: string;
  playerName: string;
  playerColor: string;
  x: number;
  y: number;
  letter: string;
  timestamp: number;
  isCorrect: boolean;
}

export interface Player {
  id: string;
  name: string;
  color: string;
  score: number;
  lastActive: number;
}

export interface GameState {
  id: string;
  grid: CrosswordGrid | null;
  guesses: Map<string, PlayerGuess>; // "x,y" -> guess
  players: Map<string, Player>;
  startTime: number;
  isGenerating: boolean;
  generationProgress: number;
}

// Generate a random player color
function randomColor(): string {
  const colors = [
    '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7',
    '#DDA0DD', '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E9',
    '#F8B500', '#00CED1', '#FF69B4', '#32CD32', '#FF4500',
    '#9370DB', '#20B2AA', '#FFD700', '#00FA9A', '#DC143C'
  ];
  return colors[Math.floor(Math.random() * colors.length)];
}

// Generate a unique ID
function generateId(): string {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

// Get or create player ID
function getPlayerId(): string {
  let id = localStorage.getItem('crossword-player-id');
  if (!id) {
    id = generateId();
    localStorage.setItem('crossword-player-id', id);
  }
  return id;
}

// Get or create player name
function getPlayerName(): string {
  let name = localStorage.getItem('crossword-player-name');
  if (!name) {
    const adjectives = ['Swift', 'Clever', 'Bold', 'Quick', 'Bright', 'Sharp', 'Keen', 'Wise'];
    const nouns = ['Fox', 'Owl', 'Eagle', 'Wolf', 'Bear', 'Hawk', 'Lion', 'Tiger'];
    name = `${adjectives[Math.floor(Math.random() * adjectives.length)]}${nouns[Math.floor(Math.random() * nouns.length)]}${Math.floor(Math.random() * 100)}`;
    localStorage.setItem('crossword-player-name', name);
  }
  return name;
}

// Get or create player color
function getPlayerColor(): string {
  let color = localStorage.getItem('crossword-player-color');
  if (!color) {
    color = randomColor();
    localStorage.setItem('crossword-player-color', color);
  }
  return color;
}

class GameStore {
  private state: GameState;
  private listeners: Set<() => void> = new Set();
  private broadcastChannel: BroadcastChannel | null = null;
  private syncInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.state = this.loadState();
    this.setupBroadcast();
    this.setupSync();
    this.joinGame();
  }

  private loadState(): GameState {
    const saved = localStorage.getItem('crossword-game-state');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        return {
          id: parsed.id || generateId(),
          grid: parsed.grid ? deserializeGrid(parsed.grid) : null,
          guesses: new Map(parsed.guesses || []),
          players: new Map(parsed.players || []),
          startTime: parsed.startTime || Date.now(),
          isGenerating: false,
          generationProgress: 0,
        };
      } catch (e) {
        console.error('Failed to load game state:', e);
      }
    }

    return {
      id: generateId(),
      grid: null,
      guesses: new Map(),
      players: new Map(),
      startTime: Date.now(),
      isGenerating: false,
      generationProgress: 0,
    };
  }

  private saveState(): void {
    const toSave = {
      id: this.state.id,
      grid: this.state.grid ? serializeGrid(this.state.grid) : null,
      guesses: Array.from(this.state.guesses.entries()),
      players: Array.from(this.state.players.entries()),
      startTime: this.state.startTime,
    };
    localStorage.setItem('crossword-game-state', JSON.stringify(toSave));
  }

  private setupBroadcast(): void {
    if (typeof BroadcastChannel !== 'undefined') {
      this.broadcastChannel = new BroadcastChannel('crossword-game');
      this.broadcastChannel.onmessage = (event) => {
        this.handleBroadcast(event.data);
      };
    }
  }

  private setupSync(): void {
    // Sync player activity every 5 seconds
    this.syncInterval = setInterval(() => {
      this.updatePlayerActivity();
    }, 5000);
  }

  private handleBroadcast(data: { type: string; payload: unknown }): void {
    switch (data.type) {
      case 'guess':
        this.applyGuess(data.payload as PlayerGuess, false);
        break;
      case 'player-join':
        this.applyPlayer(data.payload as Player, false);
        break;
      case 'player-update':
        this.applyPlayer(data.payload as Player, false);
        break;
      case 'new-game':
        this.state = this.loadState();
        this.notify();
        break;
    }
  }

  private broadcast(type: string, payload: unknown): void {
    if (this.broadcastChannel) {
      this.broadcastChannel.postMessage({ type, payload });
    }
  }

  private notify(): void {
    this.listeners.forEach(listener => listener());
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getState(): GameState {
    return this.state;
  }

  getCurrentPlayer(): Player {
    const id = getPlayerId();
    let player = this.state.players.get(id);
    if (!player) {
      player = {
        id,
        name: getPlayerName(),
        color: getPlayerColor(),
        score: 0,
        lastActive: Date.now(),
      };
      this.state.players.set(id, player);
      this.saveState();
    }
    return player;
  }

  private joinGame(): void {
    const player = this.getCurrentPlayer();
    this.broadcast('player-join', player);
  }

  private updatePlayerActivity(): void {
    const player = this.getCurrentPlayer();
    player.lastActive = Date.now();
    this.state.players.set(player.id, player);
    this.saveState();
    this.broadcast('player-update', player);
    this.notify();
  }

  private applyPlayer(player: Player, shouldBroadcast: boolean): void {
    this.state.players.set(player.id, player);
    this.saveState();
    if (shouldBroadcast) {
      this.broadcast('player-update', player);
    }
    this.notify();
  }

  setPlayerName(name: string): void {
    localStorage.setItem('crossword-player-name', name);
    const player = this.getCurrentPlayer();
    player.name = name;
    this.applyPlayer(player, true);
  }

  setPlayerColor(color: string): void {
    localStorage.setItem('crossword-player-color', color);
    const player = this.getCurrentPlayer();
    player.color = color;
    this.applyPlayer(player, true);
  }

  setGrid(grid: CrosswordGrid): void {
    this.state.grid = grid;
    this.state.guesses = new Map();
    this.state.startTime = Date.now();
    // Reset scores
    for (const player of this.state.players.values()) {
      player.score = 0;
    }
    this.saveState();
    this.broadcast('new-game', null);
    this.notify();
  }

  setGenerating(isGenerating: boolean, progress: number = 0): void {
    this.state.isGenerating = isGenerating;
    this.state.generationProgress = progress;
    this.notify();
  }

  private applyGuess(guess: PlayerGuess, shouldBroadcast: boolean): void {
    const key = `${guess.x},${guess.y}`;
    const existing = this.state.guesses.get(key);

    // Only apply if newer or doesn't exist
    if (!existing || guess.timestamp > existing.timestamp) {
      this.state.guesses.set(key, guess);

      // Update player score
      if (guess.isCorrect) {
        const player = this.state.players.get(guess.playerId);
        if (player) {
          // Only add score if this is a new correct guess by this player
          if (!existing || !existing.isCorrect) {
            player.score += 10;
            this.state.players.set(player.id, player);
          }
        }
      }

      this.saveState();

      if (shouldBroadcast) {
        this.broadcast('guess', guess);
      }

      this.notify();
    }
  }

  makeGuess(x: number, y: number, letter: string): PlayerGuess | null {
    if (!this.state.grid) return null;

    const cell = this.state.grid.cells.get(`${x},${y}`);
    if (!cell) return null;

    const player = this.getCurrentPlayer();
    const isCorrect = cell.letter === letter.toUpperCase();

    const guess: PlayerGuess = {
      id: generateId(),
      playerId: player.id,
      playerName: player.name,
      playerColor: player.color,
      x,
      y,
      letter: letter.toUpperCase(),
      timestamp: Date.now(),
      isCorrect,
    };

    this.applyGuess(guess, true);
    return guess;
  }

  getGuess(x: number, y: number): PlayerGuess | undefined {
    return this.state.guesses.get(`${x},${y}`);
  }

  getActivePlayers(): Player[] {
    const now = Date.now();
    const timeout = 30000; // 30 seconds
    return Array.from(this.state.players.values())
      .filter(p => now - p.lastActive < timeout)
      .sort((a, b) => b.score - a.score);
  }

  getLeaderboard(): Player[] {
    return Array.from(this.state.players.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);
  }

  getProgress(): { correct: number; total: number; percentage: number } {
    if (!this.state.grid) return { correct: 0, total: 0, percentage: 0 };

    const total = this.state.grid.cells.size;
    let correct = 0;

    for (const guess of this.state.guesses.values()) {
      if (guess.isCorrect) {
        correct++;
      }
    }

    return {
      correct,
      total,
      percentage: total > 0 ? Math.round((correct / total) * 100) : 0,
    };
  }

  getWordProgress(word: PlacedWord): { correct: number; total: number; isComplete: boolean } {
    const dx = word.direction === 'across' ? 1 : 0;
    const dy = word.direction === 'down' ? 1 : 0;
    let correct = 0;

    for (let i = 0; i < word.word.length; i++) {
      const x = word.x + i * dx;
      const y = word.y + i * dy;
      const guess = this.state.guesses.get(`${x},${y}`);
      if (guess?.isCorrect) {
        correct++;
      }
    }

    return {
      correct,
      total: word.word.length,
      isComplete: correct === word.word.length,
    };
  }

  resetGame(): void {
    this.state.guesses = new Map();
    this.state.startTime = Date.now();
    for (const player of this.state.players.values()) {
      player.score = 0;
    }
    this.saveState();
    this.broadcast('new-game', null);
    this.notify();
  }

  destroy(): void {
    if (this.broadcastChannel) {
      this.broadcastChannel.close();
    }
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
    }
  }
}

// Singleton instance
export const gameStore = new GameStore();
