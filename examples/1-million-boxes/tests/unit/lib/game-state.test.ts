import { beforeEach, describe, expect, it } from "vitest"
import { GameState } from "../../../shared/game-state"
import { HORIZ_COUNT, W, getBoxEdges } from "../../../shared/edge-math"

describe(`GameState`, () => {
  let state: GameState

  beforeEach(() => {
    state = new GameState()
  })

  describe(`initial state`, () => {
    it(`starts with no edges taken`, () => {
      expect(state.isEdgeTaken(0)).toBe(false)
      expect(state.isEdgeTaken(HORIZ_COUNT)).toBe(false)
      expect(state.getEdgesPlacedCount()).toBe(0)
    })

    it(`starts with all boxes unclaimed`, () => {
      expect(state.getBoxOwner(0)).toBe(0)
      expect(state.getBoxOwner(500000)).toBe(0)
    })

    it(`starts with all scores at zero`, () => {
      expect(state.getScores()).toEqual([0, 0, 0, 0])
      expect(state.getScore(0)).toBe(0)
      expect(state.getScore(1)).toBe(0)
      expect(state.getScore(2)).toBe(0)
      expect(state.getScore(3)).toBe(0)
    })

    it(`is not complete`, () => {
      expect(state.isComplete()).toBe(false)
    })

    it(`has no winner`, () => {
      expect(state.getWinner()).toBe(null)
    })
  })

  describe(`isEdgeTaken`, () => {
    it(`returns false for untaken edges`, () => {
      expect(state.isEdgeTaken(12345)).toBe(false)
    })

    it(`returns true after edge is placed`, () => {
      state.applyEvent({ edgeId: 12345, teamId: 0 })
      expect(state.isEdgeTaken(12345)).toBe(true)
    })
  })

  describe(`applyEvent`, () => {
    it(`marks edge as taken`, () => {
      state.applyEvent({ edgeId: 0, teamId: 0 })
      expect(state.isEdgeTaken(0)).toBe(true)
      expect(state.getEdgesPlacedCount()).toBe(1)
    })

    it(`ignores duplicate edge placement`, () => {
      state.applyEvent({ edgeId: 0, teamId: 0 })
      state.applyEvent({ edgeId: 0, teamId: 1 }) // Should be ignored
      expect(state.getEdgesPlacedCount()).toBe(1)
    })

    it(`returns empty boxesClaimed for non-completing edge`, () => {
      const result = state.applyEvent({ edgeId: 0, teamId: 0 })
      expect(result.boxesClaimed).toEqual([])
    })

    it(`claims box when fourth edge is placed`, () => {
      // Box at (0,0) needs edges:
      // top    = h(0,0) = 0
      // bottom = h(0,1) = W = 1000
      // left   = v(0,0) = HORIZ_COUNT
      // right  = v(1,0) = HORIZ_COUNT + 1
      const [top, bottom, left, right] = getBoxEdges(0, 0)

      expect(top).toBe(0)
      expect(bottom).toBe(W)
      expect(left).toBe(HORIZ_COUNT)
      expect(right).toBe(HORIZ_COUNT + 1)

      state.applyEvent({ edgeId: top, teamId: 0 })
      state.applyEvent({ edgeId: bottom, teamId: 1 })
      state.applyEvent({ edgeId: left, teamId: 2 })

      expect(state.getBoxOwner(0)).toBe(0) // Still unclaimed

      const result = state.applyEvent({ edgeId: right, teamId: 3 })

      expect(state.getBoxOwner(0)).toBe(4) // Claimed by team 3 (teamId + 1)
      expect(state.getScore(3)).toBe(1)
      expect(result.boxesClaimed).toEqual([0])
    })

    it(`can claim two boxes with one edge`, () => {
      // Edge at h(0, 1) borders box (0,0) and box (0,1)
      // Complete both boxes except for the shared edge

      // Box (0,0): top, left, right
      state.applyEvent({ edgeId: 0, teamId: 0 }) // top = h(0,0)
      state.applyEvent({ edgeId: HORIZ_COUNT, teamId: 0 }) // left = v(0,0)
      state.applyEvent({ edgeId: HORIZ_COUNT + 1, teamId: 0 }) // right = v(1,0)

      // Box (0,1): bottom, left, right
      state.applyEvent({ edgeId: 2 * W, teamId: 1 }) // bottom = h(0,2)
      state.applyEvent({ edgeId: HORIZ_COUNT + (W + 1), teamId: 1 }) // left = v(0,1)
      state.applyEvent({ edgeId: HORIZ_COUNT + (W + 1) + 1, teamId: 1 }) // right = v(1,1)

      // Now place the shared edge - should claim both boxes
      const result = state.applyEvent({ edgeId: W, teamId: 2 }) // h(0,1)

      expect(result.boxesClaimed).toHaveLength(2)
      expect(result.boxesClaimed).toContain(0) // box (0,0)
      expect(result.boxesClaimed).toContain(W) // box (0,1) = boxId 1000
      expect(state.getScore(2)).toBe(2)
    })
  })

  describe(`getScores`, () => {
    it(`returns copy of scores array`, () => {
      const scores = state.getScores()
      scores[0] = 999 // Mutate the copy
      expect(state.getScore(0)).toBe(0) // Original unchanged
    })
  })

  describe(`isComplete`, () => {
    it(`returns false when not all edges placed`, () => {
      state.applyEvent({ edgeId: 0, teamId: 0 })
      expect(state.isComplete()).toBe(false)
    })

    // Note: Testing full completion would require placing 2M+ edges
    // We test the logic indirectly through getEdgesPlacedCount
  })

  describe(`getWinner`, () => {
    it(`returns null for tie`, () => {
      expect(state.getWinner()).toBe(null)
    })

    it(`returns null when game is not complete`, () => {
      // Complete a box for team 2
      const [top, bottom, left, right] = getBoxEdges(0, 0)
      state.applyEvent({ edgeId: top, teamId: 0 })
      state.applyEvent({ edgeId: bottom, teamId: 1 })
      state.applyEvent({ edgeId: left, teamId: 1 })
      state.applyEvent({ edgeId: right, teamId: 2 })

      expect(state.getScores()).toEqual([0, 0, 1, 0])
      expect(state.getWinner()).toBe(null)
    })

    it(`returns null when multiple teams tied for highest`, () => {
      // Complete box (0,0) for team 0
      const box0edges = getBoxEdges(0, 0)
      state.applyEvent({ edgeId: box0edges[0], teamId: 1 })
      state.applyEvent({ edgeId: box0edges[1], teamId: 1 })
      state.applyEvent({ edgeId: box0edges[2], teamId: 1 })
      state.applyEvent({ edgeId: box0edges[3], teamId: 0 }) // Team 0 claims

      // Complete box (2,0) for team 1
      const box1edges = getBoxEdges(2, 0)
      state.applyEvent({ edgeId: box1edges[0], teamId: 0 })
      state.applyEvent({ edgeId: box1edges[1], teamId: 0 })
      state.applyEvent({ edgeId: box1edges[2], teamId: 0 })
      state.applyEvent({ edgeId: box1edges[3], teamId: 1 }) // Team 1 claims

      expect(state.getScores()).toEqual([1, 1, 0, 0])
      expect(state.getWinner()).toBe(null) // Tie
    })
  })

  describe(`export / import`, () => {
    it(`exports current state`, () => {
      state.applyEvent({ edgeId: 0, teamId: 0 })
      state.applyEvent({ edgeId: 1, teamId: 1 })

      const exported = state.export()

      expect(exported.edgesPlaced).toBe(2)
      expect(exported.scores).toEqual([0, 0, 0, 0])
      expect(exported.edgeTaken).toBeInstanceOf(Uint8Array)
      expect(exported.edgeOwner).toBeInstanceOf(Int8Array)
      expect(exported.boxOwner).toBeInstanceOf(Uint8Array)
    })

    it(`imports state correctly`, () => {
      state.applyEvent({ edgeId: 0, teamId: 0 })
      state.applyEvent({ edgeId: 1, teamId: 1 })

      const exported = state.export()
      const imported = GameState.import(exported)

      expect(imported.isEdgeTaken(0)).toBe(true)
      expect(imported.isEdgeTaken(1)).toBe(true)
      expect(imported.isEdgeTaken(2)).toBe(false)
      expect(imported.getEdgeOwner(0)).toBe(0)
      expect(imported.getEdgeOwner(1)).toBe(1)
      expect(imported.getEdgesPlacedCount()).toBe(2)
      expect(imported.getScores()).toEqual([0, 0, 0, 0])
    })

    it(`export returns a copy, not a reference`, () => {
      state.applyEvent({ edgeId: 0, teamId: 0 })
      const exported = state.export()

      // Mutate exported data
      exported.edgeTaken[0] = 0

      // Original state should be unchanged
      expect(state.isEdgeTaken(0)).toBe(true)
    })
  })

  describe(`complete box scenarios`, () => {
    it(`completing box in center of grid`, () => {
      const [top, bottom, left, right] = getBoxEdges(500, 500)

      state.applyEvent({ edgeId: top, teamId: 0 })
      state.applyEvent({ edgeId: bottom, teamId: 1 })
      state.applyEvent({ edgeId: left, teamId: 2 })

      expect(state.getBoxOwner(500 * W + 500)).toBe(0) // Unclaimed

      state.applyEvent({ edgeId: right, teamId: 3 })

      const boxId = 500 * W + 500
      expect(state.getBoxOwner(boxId)).toBe(4) // Team 3
      expect(state.getScore(3)).toBe(1)
    })

    it(`completing corner box (999, 999)`, () => {
      const [top, bottom, left, right] = getBoxEdges(999, 999)

      state.applyEvent({ edgeId: top, teamId: 0 })
      state.applyEvent({ edgeId: bottom, teamId: 0 })
      state.applyEvent({ edgeId: left, teamId: 0 })
      state.applyEvent({ edgeId: right, teamId: 1 })

      const boxId = 999 * W + 999
      expect(state.getBoxOwner(boxId)).toBe(2) // Team 1
    })
  })
})
