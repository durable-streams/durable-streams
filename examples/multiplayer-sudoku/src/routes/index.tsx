import { createFileRoute, Link } from "@tanstack/react-router"
import { useLiveQuery } from "@tanstack/react-db"
import { useState, useMemo, useEffect } from "react"
import {
  sudokuCellsCollection,
  playerStatsCollection,
  usersCollection,
} from "@/lib/collections"
import { authClient } from "@/lib/auth-client"
import { trpc } from "@/lib/trpc-client"
import type { SudokuCell } from "@/db/schema"

export const Route = createFileRoute(`/`)({
  component: SudokuGame,
  ssr: false,
  loader: async () => {
    await Promise.all([
      sudokuCellsCollection.preload(),
      playerStatsCollection.preload(),
      usersCollection.preload(),
    ])
    return null
  },
})

// Number of puzzles arranged in grid
const PUZZLES_PER_ROW = 11
const TOTAL_PUZZLES = 123

function SudokuGame() {
  const [session, setSession] = useState<{ user: { id: string; name: string } } | null>(null)
  const [selectedCell, setSelectedCell] = useState<SudokuCell | null>(null)
  const [viewportPuzzle, setViewportPuzzle] = useState({ row: 0, col: 0 })
  const [isInitializing, setIsInitializing] = useState(false)
  const [zoom, setZoom] = useState(1)

  // Load session
  useEffect(() => {
    authClient.getSession().then((res) => {
      if (res.data?.session) {
        setSession({ user: res.data.user })
      }
    })
  }, [])

  // Get all cells
  const { data: allCells } = useLiveQuery((q) =>
    q.from({ sudokuCellsCollection })
  )

  // Get player stats
  const { data: playerStats } = useLiveQuery((q) =>
    q
      .from({ playerStatsCollection })
      .orderBy(({ playerStatsCollection }) => playerStatsCollection.cells_filled, `desc`)
      .limit(20)
  )

  // Get users for leaderboard
  const { data: users } = useLiveQuery((q) => q.from({ usersCollection }))

  // Group cells by puzzle
  const puzzlesByCells = useMemo(() => {
    const puzzles = new Map<number, SudokuCell[]>()
    for (const cell of allCells) {
      if (!puzzles.has(cell.puzzle_id)) {
        puzzles.set(cell.puzzle_id, [])
      }
      puzzles.get(cell.puzzle_id)!.push(cell)
    }
    return puzzles
  }, [allCells])

  // Calculate stats
  const stats = useMemo(() => {
    const total = allCells.length
    const filled = allCells.filter((c) => c.value !== null).length
    const given = allCells.filter((c) => c.is_given).length
    const playerFilled = filled - given
    return { total, filled, given, playerFilled, remaining: total - filled }
  }, [allCells])

  // Initialize game
  const handleInitialize = async () => {
    setIsInitializing(true)
    try {
      await trpc.sudoku.initializeGame.mutate()
      window.location.reload()
    } catch (error) {
      console.error(`Failed to initialize:`, error)
    }
    setIsInitializing(false)
  }

  // Handle cell click
  const handleCellClick = (cell: SudokuCell) => {
    if (cell.is_given) return
    if (!session) {
      alert(`Please sign in to play!`)
      return
    }
    setSelectedCell(cell)
  }

  // Handle number input
  const handleNumberInput = async (num: number | null) => {
    if (!selectedCell || !session) return

    // Optimistic update
    sudokuCellsCollection.update(selectedCell.id, (draft) => {
      draft.value = num
      draft.filled_by = num ? session.user.id : null
      draft.filled_by_name = num ? session.user.name : null
    })

    setSelectedCell(null)
  }

  // Keyboard handling
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!selectedCell) return

      if (e.key >= `1` && e.key <= `9`) {
        handleNumberInput(parseInt(e.key))
      } else if (e.key === `Backspace` || e.key === `Delete` || e.key === `0`) {
        handleNumberInput(null)
      } else if (e.key === `Escape`) {
        setSelectedCell(null)
      }
    }

    window.addEventListener(`keydown`, handleKeyDown)
    return () => window.removeEventListener(`keydown`, handleKeyDown)
  }, [selectedCell, session])

  // If no cells, show initialization screen
  if (allCells.length === 0) {
    return (
      <div className="min-h-screen flex items-center justify-center flex-col gap-6 p-4">
        <h1 className="text-4xl md:text-6xl font-bold text-center bg-gradient-to-r from-blue-400 to-purple-500 bg-clip-text text-transparent">
          Massive Multiplayer Sudoku
        </h1>
        <p className="text-xl text-slate-400 text-center">9,963 boxes across 123 puzzles</p>
        <button
          onClick={handleInitialize}
          disabled={isInitializing}
          className="px-8 py-4 bg-gradient-to-r from-blue-500 to-purple-600 rounded-lg text-xl font-semibold hover:from-blue-600 hover:to-purple-700 transition-all disabled:opacity-50"
        >
          {isInitializing ? `Generating puzzles...` : `Start the Game`}
        </button>
        <p className="text-sm text-slate-500 max-w-md text-center">
          This will generate 123 unique sudoku puzzles with approximately 9,999 cells for everyone to solve together!
        </p>
      </div>
    )
  }

  // Calculate visible puzzles based on viewport
  const visiblePuzzles = useMemo(() => {
    const puzzleIds: number[] = []
    const startRow = Math.max(0, viewportPuzzle.row - 1)
    const endRow = Math.min(Math.ceil(TOTAL_PUZZLES / PUZZLES_PER_ROW), viewportPuzzle.row + 3)
    const startCol = Math.max(0, viewportPuzzle.col - 1)
    const endCol = Math.min(PUZZLES_PER_ROW, viewportPuzzle.col + 4)

    for (let r = startRow; r < endRow; r++) {
      for (let c = startCol; c < endCol; c++) {
        const puzzleId = r * PUZZLES_PER_ROW + c
        if (puzzleId < TOTAL_PUZZLES) {
          puzzleIds.push(puzzleId)
        }
      }
    }
    return puzzleIds
  }, [viewportPuzzle])

  const userMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const user of users) {
      map.set(user.id, user.name)
    }
    return map
  }, [users])

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="bg-slate-800/80 backdrop-blur-sm border-b border-slate-700 sticky top-0 z-50">
        <div className="max-w-screen-2xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <h1 className="text-xl md:text-2xl font-bold bg-gradient-to-r from-blue-400 to-purple-500 bg-clip-text text-transparent">
              Multiplayer Sudoku
            </h1>
            <div className="hidden md:flex items-center gap-2 text-sm text-slate-400">
              <span className="px-2 py-1 bg-slate-700 rounded">{stats.total.toLocaleString()} cells</span>
              <span className="px-2 py-1 bg-green-900/50 text-green-400 rounded">
                {stats.filled.toLocaleString()} filled
              </span>
              <span className="px-2 py-1 bg-blue-900/50 text-blue-400 rounded">
                {stats.remaining.toLocaleString()} remaining
              </span>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {/* Zoom controls */}
            <div className="hidden md:flex items-center gap-1 bg-slate-700 rounded-lg p-1">
              <button
                onClick={() => setZoom((z) => Math.max(0.5, z - 0.1))}
                className="px-2 py-1 hover:bg-slate-600 rounded text-sm"
              >
                -
              </button>
              <span className="px-2 text-sm">{Math.round(zoom * 100)}%</span>
              <button
                onClick={() => setZoom((z) => Math.min(2, z + 0.1))}
                className="px-2 py-1 hover:bg-slate-600 rounded text-sm"
              >
                +
              </button>
            </div>

            {session ? (
              <div className="flex items-center gap-2">
                <span className="text-sm text-slate-300">{session.user.name}</span>
                <button
                  onClick={() => authClient.signOut().then(() => setSession(null))}
                  className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 rounded text-sm"
                >
                  Sign Out
                </button>
              </div>
            ) : (
              <Link
                to="/login"
                className="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 rounded text-sm font-medium"
              >
                Sign In to Play
              </Link>
            )}
          </div>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Main game area */}
        <main className="flex-1 overflow-auto p-4">
          {/* Mobile stats */}
          <div className="md:hidden flex flex-wrap gap-2 mb-4 text-xs">
            <span className="px-2 py-1 bg-slate-700 rounded">{stats.total.toLocaleString()} cells</span>
            <span className="px-2 py-1 bg-green-900/50 text-green-400 rounded">
              {stats.filled.toLocaleString()} filled
            </span>
          </div>

          {/* Progress bar */}
          <div className="mb-4 bg-slate-800 rounded-full h-3 overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-blue-500 to-purple-600 transition-all duration-500"
              style={{ width: `${(stats.filled / stats.total) * 100}%` }}
            />
          </div>

          {/* Navigation */}
          <div className="mb-4 flex flex-wrap gap-2">
            <span className="text-sm text-slate-400">Jump to puzzle row:</span>
            {Array.from({ length: Math.ceil(TOTAL_PUZZLES / PUZZLES_PER_ROW) }, (_, i) => (
              <button
                key={i}
                onClick={() => setViewportPuzzle({ row: i, col: 0 })}
                className={`px-2 py-1 text-xs rounded ${
                  viewportPuzzle.row === i
                    ? `bg-blue-600`
                    : `bg-slate-700 hover:bg-slate-600`
                }`}
              >
                {i + 1}
              </button>
            ))}
          </div>

          {/* Puzzle grid */}
          <div
            className="grid gap-4"
            style={{
              gridTemplateColumns: `repeat(${PUZZLES_PER_ROW}, minmax(0, 1fr))`,
              transform: `scale(${zoom})`,
              transformOrigin: `top left`,
            }}
          >
            {Array.from({ length: TOTAL_PUZZLES }, (_, puzzleId) => (
              <PuzzleGrid
                key={puzzleId}
                puzzleId={puzzleId}
                cells={puzzlesByCells.get(puzzleId) || []}
                selectedCell={selectedCell}
                onCellClick={handleCellClick}
                isVisible={visiblePuzzles.includes(puzzleId)}
              />
            ))}
          </div>
        </main>

        {/* Sidebar - Leaderboard */}
        <aside className="hidden lg:block w-64 bg-slate-800/50 border-l border-slate-700 p-4 overflow-auto">
          <h2 className="text-lg font-semibold mb-4">Leaderboard</h2>
          <div className="space-y-2">
            {playerStats.map((stat, i) => (
              <div
                key={stat.id}
                className="flex items-center gap-2 p-2 bg-slate-700/50 rounded"
              >
                <span
                  className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold"
                  style={{ backgroundColor: stat.color }}
                >
                  {i + 1}
                </span>
                <span className="flex-1 truncate text-sm">
                  {userMap.get(stat.user_id) || `Player`}
                </span>
                <span className="text-sm text-slate-400">{stat.cells_filled}</span>
              </div>
            ))}
            {playerStats.length === 0 && (
              <p className="text-sm text-slate-500">No players yet. Be the first!</p>
            )}
          </div>
        </aside>
      </div>

      {/* Number input modal */}
      {selectedCell && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
          onClick={() => setSelectedCell(null)}
        >
          <div
            className="bg-slate-800 rounded-xl p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-sm text-slate-400 mb-4 text-center">
              Puzzle {selectedCell.puzzle_id + 1}, Row {selectedCell.row + 1}, Col {selectedCell.col + 1}
            </p>
            <div className="grid grid-cols-3 gap-2">
              {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((num) => (
                <button
                  key={num}
                  onClick={() => handleNumberInput(num)}
                  className="w-14 h-14 text-2xl font-bold bg-slate-700 hover:bg-blue-600 rounded-lg transition-colors"
                >
                  {num}
                </button>
              ))}
            </div>
            <button
              onClick={() => handleNumberInput(null)}
              className="w-full mt-2 py-3 bg-red-600/20 hover:bg-red-600/40 text-red-400 rounded-lg"
            >
              Clear
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// Individual puzzle grid component
function PuzzleGrid({
  puzzleId,
  cells,
  selectedCell,
  onCellClick,
  isVisible,
}: {
  puzzleId: number
  cells: SudokuCell[]
  selectedCell: SudokuCell | null
  onCellClick: (cell: SudokuCell) => void
  isVisible: boolean
}) {
  // Sort cells by row and column
  const sortedCells = useMemo(() => {
    return [...cells].sort((a, b) => {
      if (a.row !== b.row) return a.row - b.row
      return a.col - b.col
    })
  }, [cells])

  // If not visible, render a placeholder
  if (!isVisible) {
    return (
      <div className="aspect-square bg-slate-800/30 rounded-lg flex items-center justify-center">
        <span className="text-slate-600 text-xs">#{puzzleId + 1}</span>
      </div>
    )
  }

  // If no cells yet, show loading
  if (cells.length === 0) {
    return (
      <div className="aspect-square bg-slate-800/50 rounded-lg animate-pulse" />
    )
  }

  return (
    <div className="bg-slate-800 rounded-lg p-1 shadow-lg">
      <div className="text-[8px] text-slate-500 text-center mb-0.5">#{puzzleId + 1}</div>
      <div
        className="grid gap-0"
        style={{ gridTemplateColumns: `repeat(9, 1fr)` }}
      >
        {sortedCells.map((cell) => (
          <SudokuCellComponent
            key={cell.id}
            cell={cell}
            isSelected={selectedCell?.id === cell.id}
            onClick={() => onCellClick(cell)}
          />
        ))}
      </div>
    </div>
  )
}

// Individual cell component
function SudokuCellComponent({
  cell,
  isSelected,
  onClick,
}: {
  cell: SudokuCell
  isSelected: boolean
  onClick: () => void
}) {
  const borderClasses = useMemo(() => {
    const classes: string[] = []
    // Thicker borders for 3x3 boxes
    if (cell.col % 3 === 0 && cell.col !== 0) classes.push(`border-l-2 border-l-slate-500`)
    if (cell.row % 3 === 0 && cell.row !== 0) classes.push(`border-t-2 border-t-slate-500`)
    return classes.join(` `)
  }, [cell.row, cell.col])

  return (
    <button
      onClick={onClick}
      disabled={cell.is_given}
      className={`
        aspect-square flex items-center justify-center text-[10px] font-medium
        border border-slate-700
        ${borderClasses}
        ${cell.is_given ? `bg-slate-700 text-slate-300 cursor-default` : `bg-slate-800 hover:bg-slate-600 cursor-pointer`}
        ${isSelected ? `ring-2 ring-blue-500 bg-blue-900/50` : ``}
        ${!cell.is_given && cell.value ? `text-blue-400` : ``}
        transition-colors
      `}
      style={
        cell.filled_by_color && !cell.is_given
          ? { backgroundColor: `${cell.filled_by_color}20`, color: cell.filled_by_color }
          : undefined
      }
      title={cell.filled_by_name ? `Filled by ${cell.filled_by_name}` : undefined}
    >
      {cell.value || ``}
    </button>
  )
}
