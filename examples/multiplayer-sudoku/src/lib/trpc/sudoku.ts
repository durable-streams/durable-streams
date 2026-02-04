import { router, authedProcedure, procedure, generateTxId } from "@/lib/trpc"
import { z } from "zod"
import { TRPCError } from "@trpc/server"
import { eq, sql } from "drizzle-orm"
import {
  sudokuCellsTable,
  gameStateTable,
  playerStatsTable,
} from "@/db/schema"
import { generateAllPuzzles, generatePlayerColor } from "@/lib/sudoku-generator"

export const sudokuRouter = router({
  // Initialize the game with 123 puzzles (9963 cells)
  initializeGame: procedure.mutation(async ({ ctx }) => {
    // Check if game already exists
    const existingCells = await ctx.db
      .select()
      .from(sudokuCellsTable)
      .limit(1)

    if (existingCells.length > 0) {
      return { message: `Game already initialized`, cells: 0 }
    }

    // Generate all puzzles
    const puzzles = generateAllPuzzles(123) // 123 puzzles = 9963 cells

    // Insert all cells
    const allCells: {
      puzzle_id: number
      row: number
      col: number
      value: number | null
      is_given: boolean
    }[] = []

    for (const puzzle of puzzles) {
      for (const cell of puzzle.cells) {
        allCells.push({
          puzzle_id: puzzle.puzzleId,
          row: cell.row,
          col: cell.col,
          value: cell.value,
          is_given: cell.isGiven,
        })
      }
    }

    // Batch insert (in chunks to avoid hitting limits)
    const chunkSize = 1000
    for (let i = 0; i < allCells.length; i += chunkSize) {
      const chunk = allCells.slice(i, i + chunkSize)
      await ctx.db.insert(sudokuCellsTable).values(chunk)
    }

    // Count given cells
    const givenCount = allCells.filter((c) => c.is_given).length

    // Initialize game state
    await ctx.db.insert(gameStateTable).values({
      total_cells: allCells.length,
      filled_cells: givenCount,
      given_cells: givenCount,
    })

    return { message: `Game initialized`, cells: allCells.length }
  }),

  // Update a cell with the player's answer
  updateCell: authedProcedure
    .input(
      z.object({
        id: z.number(),
        value: z.number().min(1).max(9).nullable(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const result = await ctx.db.transaction(async (tx) => {
        const txid = await generateTxId(tx)

        // Get the cell first
        const [cell] = await tx
          .select()
          .from(sudokuCellsTable)
          .where(eq(sudokuCellsTable.id, input.id))

        if (!cell) {
          throw new TRPCError({
            code: `NOT_FOUND`,
            message: `Cell not found`,
          })
        }

        if (cell.is_given) {
          throw new TRPCError({
            code: `FORBIDDEN`,
            message: `Cannot modify a given cell`,
          })
        }

        // Get or create player color
        const playerColor = generatePlayerColor(ctx.session.user.id)

        // Update the cell
        const [updatedCell] = await tx
          .update(sudokuCellsTable)
          .set({
            value: input.value,
            filled_by: input.value ? ctx.session.user.id : null,
            filled_by_name: input.value ? ctx.session.user.name : null,
            filled_by_color: input.value ? playerColor : null,
            filled_at: input.value ? new Date() : null,
          })
          .where(eq(sudokuCellsTable.id, input.id))
          .returning()

        // Update player stats
        if (input.value) {
          await tx
            .insert(playerStatsTable)
            .values({
              user_id: ctx.session.user.id,
              cells_filled: 1,
              color: playerColor,
            })
            .onConflictDoUpdate({
              target: playerStatsTable.user_id,
              set: {
                cells_filled: sql`${playerStatsTable.cells_filled} + 1`,
                updated_at: new Date(),
              },
            })
        }

        return { cell: updatedCell, txid }
      })

      return result
    }),

  // Get game statistics
  getStats: procedure.query(async ({ ctx }) => {
    const [gameState] = await ctx.db.select().from(gameStateTable).limit(1)

    const filledCells = await ctx.db
      .select({ count: sql<number>`count(*)` })
      .from(sudokuCellsTable)
      .where(sql`${sudokuCellsTable.value} IS NOT NULL`)

    const topPlayers = await ctx.db
      .select()
      .from(playerStatsTable)
      .orderBy(sql`${playerStatsTable.cells_filled} DESC`)
      .limit(10)

    return {
      gameState,
      filledCells: Number(filledCells[0]?.count || 0),
      topPlayers,
    }
  }),

  // Reset the game (admin only - simplified for demo)
  resetGame: procedure.mutation(async ({ ctx }) => {
    await ctx.db.delete(sudokuCellsTable)
    await ctx.db.delete(gameStateTable)
    await ctx.db.delete(playerStatsTable)

    return { message: `Game reset` }
  }),
})
