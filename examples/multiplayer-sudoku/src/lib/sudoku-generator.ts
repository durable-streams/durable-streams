// Sudoku Puzzle Generator
// Generates 123 standard 9x9 sudoku puzzles for approximately 9999 cells

type Grid = (number | null)[][]

// Generate a complete valid sudoku solution using backtracking
function generateSolution(): Grid {
  const grid: Grid = Array(9)
    .fill(null)
    .map(() => Array(9).fill(null))

  function isValid(grid: Grid, row: number, col: number, num: number): boolean {
    // Check row
    for (let x = 0; x < 9; x++) {
      if (grid[row][x] === num) return false
    }

    // Check column
    for (let x = 0; x < 9; x++) {
      if (grid[x][col] === num) return false
    }

    // Check 3x3 box
    const boxRow = Math.floor(row / 3) * 3
    const boxCol = Math.floor(col / 3) * 3
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        if (grid[boxRow + i][boxCol + j] === num) return false
      }
    }

    return true
  }

  function solve(grid: Grid): boolean {
    for (let row = 0; row < 9; row++) {
      for (let col = 0; col < 9; col++) {
        if (grid[row][col] === null) {
          // Shuffle numbers 1-9 for randomness
          const nums = [1, 2, 3, 4, 5, 6, 7, 8, 9]
          for (let i = nums.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1))
            ;[nums[i], nums[j]] = [nums[j], nums[i]]
          }

          for (const num of nums) {
            if (isValid(grid, row, col, num)) {
              grid[row][col] = num
              if (solve(grid)) return true
              grid[row][col] = null
            }
          }
          return false
        }
      }
    }
    return true
  }

  solve(grid)
  return grid
}

// Remove cells from a complete solution to create a puzzle
// Difficulty: 0.3 = easy (30% removed), 0.5 = medium, 0.7 = hard
function createPuzzle(solution: Grid, difficulty: number = 0.5): { puzzle: Grid; solution: Grid } {
  const puzzle: Grid = solution.map((row) => [...row])
  const cellsToRemove = Math.floor(81 * difficulty)

  // Create list of all cell positions
  const positions: [number, number][] = []
  for (let i = 0; i < 9; i++) {
    for (let j = 0; j < 9; j++) {
      positions.push([i, j])
    }
  }

  // Shuffle positions
  for (let i = positions.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[positions[i], positions[j]] = [positions[j], positions[i]]
  }

  // Remove cells
  for (let i = 0; i < cellsToRemove; i++) {
    const [row, col] = positions[i]
    puzzle[row][col] = null
  }

  return { puzzle, solution }
}

export interface SudokuPuzzle {
  puzzleId: number
  cells: {
    row: number
    col: number
    value: number | null
    isGiven: boolean
    solution: number
  }[]
}

// Generate a single puzzle with all cell data
export function generateSinglePuzzle(puzzleId: number, difficulty: number = 0.45): SudokuPuzzle {
  const solution = generateSolution()
  const { puzzle } = createPuzzle(solution, difficulty)

  const cells: SudokuPuzzle['cells'] = []
  for (let row = 0; row < 9; row++) {
    for (let col = 0; col < 9; col++) {
      cells.push({
        row,
        col,
        value: puzzle[row][col],
        isGiven: puzzle[row][col] !== null,
        solution: solution[row][col]!,
      })
    }
  }

  return { puzzleId, cells }
}

// Generate all 123 puzzles for the game (9963 cells, close to 9999)
export function generateAllPuzzles(count: number = 123): SudokuPuzzle[] {
  const puzzles: SudokuPuzzle[] = []

  // Vary difficulty across puzzles
  for (let i = 0; i < count; i++) {
    // Difficulty ranges from 0.35 (easier) to 0.55 (harder)
    const difficulty = 0.35 + (i % 10) * 0.02
    puzzles.push(generateSinglePuzzle(i, difficulty))
  }

  return puzzles
}

// Get grid position for a puzzle in the 11x11+2 layout (123 puzzles)
export function getPuzzlePosition(puzzleId: number): { gridRow: number; gridCol: number } {
  // Arrange in 11 columns, wrapping rows
  const gridCol = puzzleId % 11
  const gridRow = Math.floor(puzzleId / 11)
  return { gridRow, gridCol }
}

// Validate a move against the solution
export function validateMove(
  puzzleId: number,
  row: number,
  col: number,
  value: number,
  solutions: Map<string, number>
): boolean {
  const key = `${puzzleId}-${row}-${col}`
  return solutions.get(key) === value
}

// Generate player color based on user ID
export function generatePlayerColor(userId: string): string {
  // Hash the user ID to get a consistent color
  let hash = 0
  for (let i = 0; i < userId.length; i++) {
    hash = userId.charCodeAt(i) + ((hash << 5) - hash)
    hash = hash & hash // Convert to 32bit integer
  }

  // Generate HSL color with good saturation and lightness
  const hue = Math.abs(hash) % 360
  const saturation = 65 + (Math.abs(hash >> 8) % 20) // 65-85%
  const lightness = 45 + (Math.abs(hash >> 16) % 15) // 45-60%

  // Convert HSL to hex
  return hslToHex(hue, saturation, lightness)
}

function hslToHex(h: number, s: number, l: number): string {
  s /= 100
  l /= 100

  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2

  let r = 0, g = 0, b = 0

  if (0 <= h && h < 60) {
    r = c; g = x; b = 0
  } else if (60 <= h && h < 120) {
    r = x; g = c; b = 0
  } else if (120 <= h && h < 180) {
    r = 0; g = c; b = x
  } else if (180 <= h && h < 240) {
    r = 0; g = x; b = c
  } else if (240 <= h && h < 300) {
    r = x; g = 0; b = c
  } else if (300 <= h && h < 360) {
    r = c; g = 0; b = x
  }

  const toHex = (n: number) => {
    const hex = Math.round((n + m) * 255).toString(16)
    return hex.length === 1 ? '0' + hex : hex
  }

  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}
