import { createCollection } from "@tanstack/react-db"
import { electricCollectionOptions } from "@tanstack/electric-db-collection"
import {
  selectSudokuCellSchema,
  selectPlayerStatsSchema,
  selectUsersSchema,
  selectGameStateSchema,
} from "@/db/schema"
import { trpc } from "@/lib/trpc-client"

const getBaseUrl = () =>
  typeof window !== `undefined` ? window.location.origin : `http://localhost:5173`

export const usersCollection = createCollection(
  electricCollectionOptions({
    id: `users`,
    shapeOptions: {
      url: new URL(`/api/users`, getBaseUrl()).toString(),
      parser: {
        timestamptz: (date: string) => new Date(date),
      },
    },
    schema: selectUsersSchema,
    getKey: (item) => item.id,
  })
)

export const sudokuCellsCollection = createCollection(
  electricCollectionOptions({
    id: `sudoku_cells`,
    shapeOptions: {
      url: new URL(`/api/sudoku-cells`, getBaseUrl()).toString(),
      parser: {
        timestamptz: (date: string) => new Date(date),
      },
    },
    schema: selectSudokuCellSchema,
    getKey: (item) => item.id,
    onUpdate: async ({ transaction }) => {
      const { modified: updatedCell } = transaction.mutations[0]
      const result = await trpc.sudoku.updateCell.mutate({
        id: updatedCell.id,
        value: updatedCell.value,
      })

      return { txid: result.txid }
    },
  })
)

export const gameStateCollection = createCollection(
  electricCollectionOptions({
    id: `game_state`,
    shapeOptions: {
      url: new URL(`/api/game-state`, getBaseUrl()).toString(),
      parser: {
        timestamptz: (date: string) => new Date(date),
      },
    },
    schema: selectGameStateSchema,
    getKey: (item) => item.id,
  })
)

export const playerStatsCollection = createCollection(
  electricCollectionOptions({
    id: `player_stats`,
    shapeOptions: {
      url: new URL(`/api/player-stats`, getBaseUrl()).toString(),
      parser: {
        timestamptz: (date: string) => new Date(date),
      },
    },
    schema: selectPlayerStatsSchema,
    getKey: (item) => item.id,
  })
)
