/**
 * Hand-drawn rendering utilities for the game canvas.
 * These functions create a sketchy, hand-drawn aesthetic.
 */

/**
 * Create a seeded random number generator.
 */
function createRandom(seed: number): () => number {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return (seed / 0x7fffffff) * 2 - 1 // -1 to 1
  }
}

/**
 * Create a seeded random number generator returning 0-1.
 */
function createRandomPositive(seed: number): () => number {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff // 0 to 1
  }
}

type RenderingContext2D =
  | CanvasRenderingContext2D
  | OffscreenCanvasRenderingContext2D

/**
 * Draw a wobbly line using quadratic bezier curves.
 * The line has a hand-drawn appearance with slight imperfections.
 */
export function drawWobblyLine(
  ctx: RenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  wobbleAmount: number = 2,
  seed: number = 0
): void {
  const random = createRandom(seed)

  const dx = x2 - x1
  const dy = y2 - y1
  const length = Math.sqrt(dx * dx + dy * dy)

  if (length < 0.001) return

  // Perpendicular direction for wobble
  const px = -dy / length
  const py = dx / length

  // Control point at midpoint with wobble
  const midX = (x1 + x2) / 2 + px * wobbleAmount * random()
  const midY = (y1 + y2) / 2 + py * wobbleAmount * random()

  ctx.beginPath()
  ctx.moveTo(x1 + random() * 0.5, y1 + random() * 0.5)
  ctx.quadraticCurveTo(midX, midY, x2 + random() * 0.5, y2 + random() * 0.5)
  ctx.stroke()
}

/**
 * Draw a slightly irregular dot (circle with wobble).
 */
export function drawWobblyDot(
  ctx: RenderingContext2D,
  x: number,
  y: number,
  radius: number,
  seed: number = 0
): void {
  const random = createRandom(seed)

  ctx.beginPath()

  // Draw slightly irregular circle using 8 points
  const points = 8
  for (let i = 0; i <= points; i++) {
    const angle = (i / points) * Math.PI * 2
    const r = radius * (1 + random() * 0.1)
    const px = x + Math.cos(angle) * r
    const py = y + Math.sin(angle) * r

    if (i === 0) {
      ctx.moveTo(px, py)
    } else {
      ctx.lineTo(px, py)
    }
  }

  ctx.closePath()
  ctx.fill()
}

/**
 * Draw a watercolor-style box fill with layered, slightly transparent fills.
 */
export function drawWatercolorFill(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  color: string,
  seed: number = 0
): void {
  const random = createRandomPositive(seed)

  // Main fill with some transparency variation
  ctx.fillStyle = color

  // Scale inset and wobble based on box size to prevent gaps at small sizes
  // At large sizes (50px+), use full effect. At small sizes (4px), minimal effect.
  const effectScale = Math.min(1, (size - 4) / 46) // 0 at 4px, 1 at 50px+
  const baseInset = effectScale * 2 // 0-2px inset based on size
  const wobbleScale = effectScale * 1 // 0-1px wobble based on size

  // Reduce layers at smaller sizes for performance (3 layers not visible at small sizes)
  const layers = size < 10 ? 1 : size < 25 ? 2 : 3
  for (let layer = 0; layer < layers; layer++) {
    ctx.globalAlpha = 0.3 + random() * 0.2

    const inset = baseInset * (0.5 + random() * 0.5)
    const wobble = wobbleScale

    ctx.beginPath()
    ctx.moveTo(x + inset + random() * wobble, y + inset + random() * wobble)
    ctx.lineTo(
      x + size - inset + random() * wobble,
      y + inset + random() * wobble
    )
    ctx.lineTo(
      x + size - inset + random() * wobble,
      y + size - inset + random() * wobble
    )
    ctx.lineTo(
      x + inset + random() * wobble,
      y + size - inset + random() * wobble
    )
    ctx.closePath()
    ctx.fill()
  }

  ctx.globalAlpha = 1
}
