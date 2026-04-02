import type { TerritoryCell, TerritoryPlayer } from "../utils/game-logic"

/**
 * Greedy pathfinder: returns a single {dx, dy} step toward the target,
 * avoiding cells occupied by other players and preferring unclaimed cells.
 */
export function nextStep(
  current: { x: number; y: number },
  target: { x: number; y: number },
  others: Map<string, TerritoryPlayer>,
  cols: number,
  rows: number,
  cells?: Map<string, TerritoryCell>,
  myId?: string
): { dx: number; dy: number } {
  const diffX = target.x - current.x
  const diffY = target.y - current.y

  if (diffX === 0 && diffY === 0) {
    return { dx: 0, dy: 0 }
  }

  // Build set of occupied positions
  const occupied = new Set<string>()
  others.forEach((p) => {
    occupied.add(`${p.x},${p.y}`)
  })

  // Rank candidates: prefer the axis with larger distance
  const candidates: Array<{ dx: number; dy: number }> = []

  if (Math.abs(diffX) >= Math.abs(diffY)) {
    // Primary: horizontal, secondary: vertical
    if (diffX !== 0) candidates.push({ dx: diffX > 0 ? 1 : -1, dy: 0 })
    if (diffY !== 0) candidates.push({ dx: 0, dy: diffY > 0 ? 1 : -1 })
    // Perpendicular fallbacks
    if (diffY === 0) {
      candidates.push({ dx: 0, dy: 1 })
      candidates.push({ dx: 0, dy: -1 })
    }
    if (diffX === 0) {
      candidates.push({ dx: 1, dy: 0 })
      candidates.push({ dx: -1, dy: 0 })
    }
  } else {
    // Primary: vertical, secondary: horizontal
    if (diffY !== 0) candidates.push({ dx: 0, dy: diffY > 0 ? 1 : -1 })
    if (diffX !== 0) candidates.push({ dx: diffX > 0 ? 1 : -1, dy: 0 })
    // Perpendicular fallbacks
    if (diffX === 0) {
      candidates.push({ dx: 1, dy: 0 })
      candidates.push({ dx: -1, dy: 0 })
    }
    if (diffY === 0) {
      candidates.push({ dx: 0, dy: 1 })
      candidates.push({ dx: 0, dy: -1 })
    }
  }

  // Filter valid moves (in bounds, not occupied by another player)
  const valid = candidates.filter((dir) => {
    const nx = current.x + dir.dx
    const ny = current.y + dir.dy
    if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) return false
    if (occupied.has(`${nx},${ny}`)) return false
    return true
  })

  if (valid.length === 0) {
    // Completely blocked by other players — pick any in-bounds direction
    for (const dir of candidates) {
      const nx = current.x + dir.dx
      const ny = current.y + dir.dy
      if (nx >= 0 && nx < cols && ny >= 0 && ny < rows) return dir
    }
    return { dx: 0, dy: 0 }
  }

  // If we have cell data, prefer unclaimed cells over our own
  if (cells && myId) {
    const unclaimed = valid.filter((dir) => {
      const key = `${current.x + dir.dx},${current.y + dir.dy}`
      const cell = cells.get(key)
      return !cell || cell.owner !== myId
    })
    if (unclaimed.length > 0) return unclaimed[0]
  }

  // Always move — even over own cells — rather than freezing
  return valid[0]
}
