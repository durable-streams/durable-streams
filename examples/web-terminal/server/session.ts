import { DurableStream } from "@durable-streams/client"
import {
  attachContainer,
  createContainer,
  getContainer,
  resumeContainer,
  updateActivity,
} from "./docker-manager.js"

const DS_SERVER_URL = process.env.DS_SERVER_URL || `http://localhost:4437`

interface ActiveSession {
  sessionId: string
  outputStream: DurableStream
  inputAbortController: AbortController
}

const activeSessions = new Map<string, ActiveSession>()

async function createStreams(sessionId: string): Promise<{
  outputStream: DurableStream
  inputStreamUrl: string
  outputStreamUrl: string
}> {
  const outputStreamUrl = `${DS_SERVER_URL}/v1/stream/terminal/${sessionId}/output`
  const inputStreamUrl = `${DS_SERVER_URL}/v1/stream/terminal/${sessionId}/input`

  // Create output stream for server to write PTY output
  const outputStream = await DurableStream.create({
    url: outputStreamUrl,
    contentType: `application/octet-stream`,
  })

  // Create input stream for browser to write keystrokes
  await DurableStream.create({
    url: inputStreamUrl,
    contentType: `application/octet-stream`,
  })

  return { outputStream, inputStreamUrl, outputStreamUrl }
}

export async function startSession(
  sessionId: string,
  image?: string
): Promise<{
  sessionId: string
  inputStreamUrl: string
  outputStreamUrl: string
}> {
  // Check if session is already active
  if (activeSessions.has(sessionId)) {
    return {
      sessionId,
      inputStreamUrl: `${DS_SERVER_URL}/v1/stream/terminal/${sessionId}/input`,
      outputStreamUrl: `${DS_SERVER_URL}/v1/stream/terminal/${sessionId}/output`,
    }
  }

  // Create or get container
  let container = getContainer(sessionId)
  if (!container) {
    container = await createContainer(sessionId, image)
    console.log(`Created new container for session ${sessionId}`)
  } else {
    // Resume if stopped
    await resumeContainer(sessionId)
    console.log(`Resumed container for session ${sessionId}`)
  }

  // Create streams
  const { outputStream, inputStreamUrl, outputStreamUrl } =
    await createStreams(sessionId)

  // Attach to container PTY
  const dockerStream = await attachContainer(sessionId)

  // Set up abort controller for cleanup
  const inputAbortController = new AbortController()

  // Pipe container output to durable stream
  dockerStream.on(`data`, async (data: Buffer) => {
    try {
      await outputStream.append(data)
      updateActivity(sessionId)
    } catch (err) {
      console.error(`Error writing to output stream for ${sessionId}:`, err)
    }
  })

  dockerStream.on(`end`, () => {
    console.log(`Container stream ended for session ${sessionId}`)
    cleanupSession(sessionId)
  })

  dockerStream.on(`error`, (err) => {
    console.error(`Container stream error for ${sessionId}:`, err)
    cleanupSession(sessionId)
  })

  // Subscribe to input stream and write to container
  subscribeToInput(sessionId, dockerStream, inputAbortController.signal)

  activeSessions.set(sessionId, {
    sessionId,
    outputStream,
    inputAbortController,
  })

  return {
    sessionId,
    inputStreamUrl,
    outputStreamUrl,
  }
}

async function subscribeToInput(
  sessionId: string,
  dockerStream: NodeJS.ReadWriteStream,
  abortSignal: AbortSignal
): Promise<void> {
  const inputStreamUrl = `${DS_SERVER_URL}/v1/stream/terminal/${sessionId}/input`
  const inputStream = new DurableStream({ url: inputStreamUrl })

  try {
    // First, skip to the end of existing data to avoid replaying old input
    const catchUp = await inputStream.stream({
      live: false, // Don't wait, just catch up
    })
    // Drain the catch-up to get to the current offset
    let currentOffset: string | undefined
    catchUp.subscribeBytes(async (chunk) => {
      currentOffset = chunk.offset
    })
    // Wait a bit for drain to complete
    await new Promise((resolve) => setTimeout(resolve, 100))

    // Now subscribe for new data only, starting from current position
    const response = await inputStream.stream({
      live: `long-poll`,
      offset: currentOffset, // Start from where we are, not beginning
      signal: abortSignal,
    })

    response.subscribeBytes(async (chunk) => {
      if (abortSignal.aborted) return

      try {
        dockerStream.write(chunk.data)
        updateActivity(sessionId)
      } catch (err) {
        console.error(`Error writing to container for ${sessionId}:`, err)
      }
    })
  } catch (err) {
    if (!abortSignal.aborted) {
      console.error(`Error subscribing to input stream for ${sessionId}:`, err)
    }
  }
}

export function cleanupSession(sessionId: string): void {
  const session = activeSessions.get(sessionId)
  if (session) {
    session.inputAbortController.abort()
    activeSessions.delete(sessionId)
    console.log(`Cleaned up active session ${sessionId}`)
  }
}

export function isSessionActive(sessionId: string): boolean {
  return activeSessions.has(sessionId)
}
