#!/usr/bin/env npx tsx
/**
 * Seed the game with a specified percentage of completed boxes.
 *
 * Usage:
 *   npx tsx scripts/seed-game.ts <percentage> [--url <stream-url>]
 *
 * Examples:
 *   npx tsx scripts/seed-game.ts 10          # Fill 10% of boxes
 *   npx tsx scripts/seed-game.ts 50 --url http://localhost:8787
 *
 * This script will:
 * 1. Delete the existing game stream
 * 2. Create a new empty stream
 * 3. Randomly select boxes to complete
 * 4. Write edges to complete those boxes
 */

import { DurableStream, DurableStreamError } from "@durable-streams/client"
import {
  GAME_STREAM_PATH,
  GRID_HEIGHT,
  GRID_WIDTH,
  TOTAL_BOX_COUNT,
} from "../shared/game-config"
import { encodeHeader } from "../shared/stream-parser"

// Default stream URL (local dev) - matches wrangler.jsonc DURABLE_STREAMS_URL
const DEFAULT_STREAM_URL = `http://localhost:4437/v1/stream`

// Parse command line arguments
function parseArgs(): { percentage: number; streamUrl: string } {
  const args = process.argv.slice(2)

  if (args.length === 0 || args[0] === `--help` || args[0] === `-h`) {
    console.log(`
Usage: npx tsx scripts/seed-game.ts <percentage> [--url <stream-url>]

Arguments:
  percentage    Percentage of boxes to complete (1-100)
  --url         Durable Streams server URL (default: ${DEFAULT_STREAM_URL})

Examples:
  npx tsx scripts/seed-game.ts 10
  npx tsx scripts/seed-game.ts 50 --url http://localhost:8787
`)
    process.exit(0)
  }

  const percentage = parseInt(args[0], 10)
  if (isNaN(percentage) || percentage < 1 || percentage > 100) {
    console.error(`Error: percentage must be between 1 and 100`)
    process.exit(1)
  }

  let streamUrl = DEFAULT_STREAM_URL
  const urlIndex = args.indexOf(`--url`)
  if (urlIndex !== -1 && args[urlIndex + 1]) {
    streamUrl = args[urlIndex + 1]
  }

  return { percentage, streamUrl }
}

// Edge math functions (simplified from src/lib/edge-math.ts)
const W = GRID_WIDTH
const H = GRID_HEIGHT
const HORIZ_COUNT = W * (H + 1)

function getBoxEdges(x: number, y: number): [number, number, number, number] {
  const top = y * W + x
  const bottom = (y + 1) * W + x
  const left = HORIZ_COUNT + y * (W + 1) + x
  const right = HORIZ_COUNT + y * (W + 1) + (x + 1)
  return [top, bottom, left, right]
}

function boxIdToCoords(boxId: number): { x: number; y: number } {
  return {
    x: boxId % W,
    y: Math.floor(boxId / W),
  }
}

// Encode a game event (edgeId + teamId) as 3-byte packed binary
// Format: packed = (edgeId << 2) | teamId, stored as big-endian 24-bit
function encodeEvent(edgeId: number, teamId: number): Uint8Array {
  const packed = (edgeId << 2) | teamId
  return new Uint8Array([
    (packed >> 16) & 0xff,
    (packed >> 8) & 0xff,
    packed & 0xff,
  ])
}

// Shuffle array in place (Fisher-Yates)
function shuffle<T>(array: Array<T>): Array<T> {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[array[i], array[j]] = [array[j], array[i]]
  }
  return array
}

async function main() {
  const { percentage, streamUrl } = parseArgs()
  const streamPath = `${streamUrl}${GAME_STREAM_PATH}`

  console.log(`\n🎮 Game Seeder`)
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
  console.log(`Stream URL: ${streamPath}`)
  console.log(`Grid size: ${W}x${H} (${TOTAL_BOX_COUNT.toLocaleString()} boxes)`)
  console.log(`Target: ${percentage}% complete`)
  console.log(``)

  // Create DurableStream client
  const stream = new DurableStream({
    url: streamPath,
    contentType: `application/octet-stream`,
    batching: false, // Disable batching for seeding script
  })

  // Step 1: Delete existing stream
  console.log(`🗑️  Deleting existing stream...`)
  try {
    await stream.delete()
    console.log(`   Stream deleted`)
  } catch (err) {
    if (
      err instanceof DurableStreamError &&
      (err).code === `NOT_FOUND`
    ) {
      console.log(`   Stream didn't exist (OK)`)
    } else {
      console.log(`   Warning: Delete failed (stream may not exist)`)
    }
  }

  // Step 2: Create new stream
  console.log(`📝 Creating new stream...`)
  await stream.create()
  console.log(`   Stream created`)

  // Step 2b: Write header with game start timestamp
  console.log(`📝 Writing header...`)
  const header = encodeHeader(Date.now())
  await stream.append(header)
  console.log(`   Header written`)

  // Step 3: Calculate boxes to complete
  const targetBoxes = Math.floor(TOTAL_BOX_COUNT * (percentage / 100))
  console.log(`📦 Selecting ${targetBoxes.toLocaleString()} boxes to complete...`)

  // Create array of all box IDs and shuffle
  const allBoxIds = Array.from({ length: TOTAL_BOX_COUNT }, (_, i) => i)
  shuffle(allBoxIds)
  const selectedBoxes = allBoxIds.slice(0, targetBoxes)

  // Step 4: Collect all edges needed and track which boxes they complete
  console.log(`🔗 Calculating edges...`)
  const edgeSet = new Set<number>()

  for (const boxId of selectedBoxes) {
    const { x, y } = boxIdToCoords(boxId)
    const edges = getBoxEdges(x, y)
    for (const edge of edges) {
      edgeSet.add(edge)
    }
  }

  const edges = Array.from(edgeSet)
  console.log(`   ${edges.length.toLocaleString()} unique edges to draw`)

  // Step 5: Write edges to stream in batches
  console.log(`✏️  Writing edges to stream...`)

  const BATCH_SIZE = 1000
  let written = 0

  for (let i = 0; i < edges.length; i += BATCH_SIZE) {
    const batch = edges.slice(i, i + BATCH_SIZE)

    // Encode all events in this batch
    const buffers: Array<Uint8Array> = []
    for (const edgeId of batch) {
      // Assign random team (0-3)
      const teamId = Math.floor(Math.random() * 4)
      buffers.push(encodeEvent(edgeId, teamId))
    }

    // Concatenate into single buffer
    const totalLength = buffers.reduce((sum, b) => sum + b.length, 0)
    const combined = new Uint8Array(totalLength)
    let offset = 0
    for (const buf of buffers) {
      combined.set(buf, offset)
      offset += buf.length
    }

    // Write to stream
    await stream.append(combined)

    written += batch.length
    const pct = Math.floor((written / edges.length) * 100)
    process.stdout.write(`\r   Progress: ${pct}% (${written.toLocaleString()}/${edges.length.toLocaleString()} edges)`)
  }

  console.log(`\n`)
  console.log(`✅ Done!`)
  console.log(`   ${targetBoxes.toLocaleString()} boxes completed (${percentage}%)`)
  console.log(`   ${edges.length.toLocaleString()} edges drawn`)
  console.log(``)
}

main().catch((err) => {
  console.error(`Error:`, err)
  process.exit(1)
})
