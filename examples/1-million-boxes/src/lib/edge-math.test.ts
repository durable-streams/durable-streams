import { describe, expect, it } from "vitest"
import {
  BOX_COUNT,
  EDGE_COUNT,
  H,
  HORIZ_COUNT,
  VERT_COUNT,
  W,
  boxCoordsToId,
  boxIdToCoords,
  coordsToEdgeId,
  edgeIdToCoords,
  getAdjacentBoxes,
  getBoxEdges,
  isHorizontal,
  isValidEdgeId,
} from "./edge-math"

describe(`edge-math constants`, () => {
  it(`has correct grid dimensions`, () => {
    expect(W).toBe(1000)
    expect(H).toBe(1000)
  })

  it(`has correct edge counts`, () => {
    expect(HORIZ_COUNT).toBe(1000 * 1001) // W * (H+1) = 1,001,000
    expect(VERT_COUNT).toBe(1001 * 1000) // (W+1) * H = 1,001,000
    expect(EDGE_COUNT).toBe(2002000)
  })

  it(`has correct box count`, () => {
    expect(BOX_COUNT).toBe(1000000) // W * H
  })
})

describe(`edgeIdToCoords`, () => {
  it(`converts horizontal edge at origin (0,0)`, () => {
    expect(edgeIdToCoords(0)).toEqual({ x: 0, y: 0, horizontal: true })
  })

  it(`converts horizontal edge at end of first row`, () => {
    expect(edgeIdToCoords(999)).toEqual({ x: 999, y: 0, horizontal: true })
  })

  it(`converts horizontal edge at start of second row`, () => {
    expect(edgeIdToCoords(1000)).toEqual({ x: 0, y: 1, horizontal: true })
  })

  it(`converts last horizontal edge`, () => {
    expect(edgeIdToCoords(HORIZ_COUNT - 1)).toEqual({
      x: W - 1,
      y: H,
      horizontal: true,
    })
  })

  it(`converts first vertical edge`, () => {
    expect(edgeIdToCoords(HORIZ_COUNT)).toEqual({
      x: 0,
      y: 0,
      horizontal: false,
    })
  })

  it(`converts second vertical edge`, () => {
    expect(edgeIdToCoords(HORIZ_COUNT + 1)).toEqual({
      x: 1,
      y: 0,
      horizontal: false,
    })
  })

  it(`converts last vertical edge in first row`, () => {
    expect(edgeIdToCoords(HORIZ_COUNT + W)).toEqual({
      x: W,
      y: 0,
      horizontal: false,
    })
  })

  it(`converts first vertical edge in second row`, () => {
    expect(edgeIdToCoords(HORIZ_COUNT + W + 1)).toEqual({
      x: 0,
      y: 1,
      horizontal: false,
    })
  })

  it(`converts last vertical edge`, () => {
    expect(edgeIdToCoords(EDGE_COUNT - 1)).toEqual({
      x: W,
      y: H - 1,
      horizontal: false,
    })
  })
})

describe(`coordsToEdgeId`, () => {
  it(`converts horizontal edge at origin`, () => {
    expect(coordsToEdgeId(0, 0, true)).toBe(0)
  })

  it(`converts horizontal edge at (500, 500)`, () => {
    expect(coordsToEdgeId(500, 500, true)).toBe(500 * W + 500)
  })

  it(`converts first vertical edge`, () => {
    expect(coordsToEdgeId(0, 0, false)).toBe(HORIZ_COUNT)
  })

  it(`converts vertical edge at (500, 500)`, () => {
    expect(coordsToEdgeId(500, 500, false)).toBe(
      HORIZ_COUNT + 500 * (W + 1) + 500
    )
  })
})

describe(`edgeIdToCoords / coordsToEdgeId round-trip`, () => {
  const testCases = [
    0,
    1,
    999,
    1000,
    50000,
    HORIZ_COUNT - 1,
    HORIZ_COUNT,
    HORIZ_COUNT + 1,
    HORIZ_COUNT + 1000,
    EDGE_COUNT - 1,
  ]

  testCases.forEach((id) => {
    it(`round-trips edge ID ${id}`, () => {
      const coords = edgeIdToCoords(id)
      const back = coordsToEdgeId(coords.x, coords.y, coords.horizontal)
      expect(back).toBe(id)
    })
  })
})

describe(`isHorizontal`, () => {
  it(`returns true for horizontal edges`, () => {
    expect(isHorizontal(0)).toBe(true)
    expect(isHorizontal(HORIZ_COUNT - 1)).toBe(true)
  })

  it(`returns false for vertical edges`, () => {
    expect(isHorizontal(HORIZ_COUNT)).toBe(false)
    expect(isHorizontal(EDGE_COUNT - 1)).toBe(false)
  })
})

describe(`getAdjacentBoxes`, () => {
  describe(`horizontal edges`, () => {
    it(`returns 1 box for top boundary (y=0)`, () => {
      const boxes = getAdjacentBoxes(0) // h(0, 0)
      expect(boxes).toHaveLength(1)
      expect(boxes[0]).toEqual({ x: 0, y: 0 })
    })

    it(`returns 1 box for bottom boundary (y=H)`, () => {
      const edge = coordsToEdgeId(0, H, true) // h(0, 1000)
      const boxes = getAdjacentBoxes(edge)
      expect(boxes).toHaveLength(1)
      expect(boxes[0]).toEqual({ x: 0, y: H - 1 })
    })

    it(`returns 2 boxes for interior horizontal edge`, () => {
      const edge = coordsToEdgeId(500, 500, true) // h(500, 500)
      const boxes = getAdjacentBoxes(edge)
      expect(boxes).toHaveLength(2)
      expect(boxes).toContainEqual({ x: 500, y: 499 })
      expect(boxes).toContainEqual({ x: 500, y: 500 })
    })
  })

  describe(`vertical edges`, () => {
    it(`returns 1 box for left boundary (x=0)`, () => {
      const edge = coordsToEdgeId(0, 0, false) // v(0, 0)
      const boxes = getAdjacentBoxes(edge)
      expect(boxes).toHaveLength(1)
      expect(boxes[0]).toEqual({ x: 0, y: 0 })
    })

    it(`returns 1 box for right boundary (x=W)`, () => {
      const edge = coordsToEdgeId(W, 0, false) // v(1000, 0)
      const boxes = getAdjacentBoxes(edge)
      expect(boxes).toHaveLength(1)
      expect(boxes[0]).toEqual({ x: W - 1, y: 0 })
    })

    it(`returns 2 boxes for interior vertical edge`, () => {
      const edge = coordsToEdgeId(500, 500, false) // v(500, 500)
      const boxes = getAdjacentBoxes(edge)
      expect(boxes).toHaveLength(2)
      expect(boxes).toContainEqual({ x: 499, y: 500 })
      expect(boxes).toContainEqual({ x: 500, y: 500 })
    })
  })
})

describe(`getBoxEdges`, () => {
  it(`returns correct edges for box (0,0)`, () => {
    const [top, bottom, left, right] = getBoxEdges(0, 0)

    // top = h(0, 0) = 0
    expect(top).toBe(0)
    // bottom = h(0, 1) = 1000
    expect(bottom).toBe(W)
    // left = v(0, 0) = HORIZ_COUNT
    expect(left).toBe(HORIZ_COUNT)
    // right = v(1, 0) = HORIZ_COUNT + 1
    expect(right).toBe(HORIZ_COUNT + 1)
  })

  it(`returns correct edges for box (500, 500)`, () => {
    const [top, bottom, left, right] = getBoxEdges(500, 500)

    // top = h(500, 500) = 500*1000 + 500
    expect(top).toBe(500 * W + 500)
    // bottom = h(500, 501) = 501*1000 + 500
    expect(bottom).toBe(501 * W + 500)
    // left = v(500, 500) = HORIZ_COUNT + 500*1001 + 500
    expect(left).toBe(HORIZ_COUNT + 500 * (W + 1) + 500)
    // right = v(501, 500) = HORIZ_COUNT + 500*1001 + 501
    expect(right).toBe(HORIZ_COUNT + 500 * (W + 1) + 501)
  })

  it(`returns correct edges for last box (999, 999)`, () => {
    const [top, bottom, left, right] = getBoxEdges(999, 999)

    expect(top).toBe(999 * W + 999)
    expect(bottom).toBe(1000 * W + 999)
    expect(left).toBe(HORIZ_COUNT + 999 * (W + 1) + 999)
    expect(right).toBe(HORIZ_COUNT + 999 * (W + 1) + 1000)
  })
})

describe(`boxCoordsToId / boxIdToCoords`, () => {
  it(`converts box (0,0) to id 0`, () => {
    expect(boxCoordsToId(0, 0)).toBe(0)
    expect(boxIdToCoords(0)).toEqual({ x: 0, y: 0 })
  })

  it(`converts box (999,0) to id 999`, () => {
    expect(boxCoordsToId(999, 0)).toBe(999)
    expect(boxIdToCoords(999)).toEqual({ x: 999, y: 0 })
  })

  it(`converts box (0,1) to id 1000`, () => {
    expect(boxCoordsToId(0, 1)).toBe(1000)
    expect(boxIdToCoords(1000)).toEqual({ x: 0, y: 1 })
  })

  it(`converts box (500, 500) correctly`, () => {
    const id = boxCoordsToId(500, 500)
    expect(id).toBe(500 * W + 500)
    expect(boxIdToCoords(id)).toEqual({ x: 500, y: 500 })
  })

  it(`round-trips all corner boxes`, () => {
    const corners = [
      { x: 0, y: 0 },
      { x: 999, y: 0 },
      { x: 0, y: 999 },
      { x: 999, y: 999 },
    ]
    for (const box of corners) {
      const id = boxCoordsToId(box.x, box.y)
      expect(boxIdToCoords(id)).toEqual(box)
    }
  })
})

describe(`isValidEdgeId`, () => {
  it(`returns true for valid edge IDs`, () => {
    expect(isValidEdgeId(0)).toBe(true)
    expect(isValidEdgeId(1000000)).toBe(true)
    expect(isValidEdgeId(EDGE_COUNT - 1)).toBe(true)
  })

  it(`returns false for negative edge IDs`, () => {
    expect(isValidEdgeId(-1)).toBe(false)
  })

  it(`returns false for edge IDs >= EDGE_COUNT`, () => {
    expect(isValidEdgeId(EDGE_COUNT)).toBe(false)
    expect(isValidEdgeId(EDGE_COUNT + 1)).toBe(false)
  })

  it(`returns false for non-integer edge IDs`, () => {
    expect(isValidEdgeId(0.5)).toBe(false)
    expect(isValidEdgeId(NaN)).toBe(false)
  })
})
