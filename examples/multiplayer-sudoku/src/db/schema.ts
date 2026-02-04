import {
  boolean,
  integer,
  pgTable,
  timestamp,
  varchar,
  text,
  smallint,
} from "drizzle-orm/pg-core"
import { createSchemaFactory } from "drizzle-zod"
import { z } from "zod"
export * from "./auth-schema"
import { users } from "./auth-schema"

const { createInsertSchema, createSelectSchema, createUpdateSchema } =
  createSchemaFactory({ zodInstance: z })

// Sudoku cells table - each cell is a row
// For 9999 boxes, we use 123 standard 9x9 puzzles = 9,963 cells
export const sudokuCellsTable = pgTable(`sudoku_cells`, {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  puzzle_id: smallint(`puzzle_id`).notNull(), // 0-122 for 123 puzzles
  row: smallint(`row`).notNull(), // 0-8 within the puzzle
  col: smallint(`col`).notNull(), // 0-8 within the puzzle
  value: smallint(`value`), // 1-9 or null if empty
  is_given: boolean(`is_given`).notNull().default(false), // pre-filled number
  filled_by: text(`filled_by`).references(() => users.id, { onDelete: `set null` }),
  filled_by_name: varchar(`filled_by_name`, { length: 255 }),
  filled_by_color: varchar(`filled_by_color`, { length: 7 }), // hex color like #FF5733
  filled_at: timestamp({ withTimezone: true }),
  created_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
})

// Game state table for tracking overall progress
export const gameStateTable = pgTable(`game_state`, {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  total_cells: integer(`total_cells`).notNull().default(9963),
  filled_cells: integer(`filled_cells`).notNull().default(0),
  given_cells: integer(`given_cells`).notNull().default(0),
  started_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  completed_at: timestamp({ withTimezone: true }),
})

// Player scores/stats
export const playerStatsTable = pgTable(`player_stats`, {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  user_id: text(`user_id`)
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: `cascade` }),
  cells_filled: integer(`cells_filled`).notNull().default(0),
  correct_cells: integer(`correct_cells`).notNull().default(0),
  color: varchar(`color`, { length: 7 }).notNull(), // player's assigned color
  updated_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
})

export const selectSudokuCellSchema = createSelectSchema(sudokuCellsTable)
export const createSudokuCellSchema = createInsertSchema(sudokuCellsTable).omit({
  created_at: true,
})
export const updateSudokuCellSchema = createUpdateSchema(sudokuCellsTable)

export const selectGameStateSchema = createSelectSchema(gameStateTable)
export const selectPlayerStatsSchema = createSelectSchema(playerStatsTable)
export const createPlayerStatsSchema = createInsertSchema(playerStatsTable).omit({
  updated_at: true,
})
export const updatePlayerStatsSchema = createUpdateSchema(playerStatsTable)

export type SudokuCell = z.infer<typeof selectSudokuCellSchema>
export type UpdateSudokuCell = z.infer<typeof updateSudokuCellSchema>
export type GameState = z.infer<typeof selectGameStateSchema>
export type PlayerStats = z.infer<typeof selectPlayerStatsSchema>

export const selectUsersSchema = createSelectSchema(users)
