import { randomUUID } from "node:crypto"
import express from "express"
import cors from "cors"
import {
  deleteContainer,
  listSessions,
  resizeContainer,
  restoreExistingSessions,
  stopContainer,
} from "./docker-manager.js"
import { cleanupSession, isSessionActive, startSession } from "./session.js"

const app = express()
const PORT = process.env.PORT || 3001
const DS_SERVER_URL = process.env.DS_SERVER_URL || `http://localhost:4437`

app.use(cors())
app.use(express.json())

// Create a new terminal session
app.post(`/api/sessions`, async (req, res) => {
  try {
    const sessionId = randomUUID()
    const { image } = req.body as { image?: string }

    const result = await startSession(sessionId, image)

    res.json({
      sessionId: result.sessionId,
      inputStreamUrl: result.inputStreamUrl,
      outputStreamUrl: result.outputStreamUrl,
    })
  } catch (err) {
    console.error(`Error creating session:`, err)
    res.status(500).json({ error: `Failed to create session` })
  }
})

// Connect to an existing session
app.post(`/api/sessions/:sessionId/connect`, async (req, res) => {
  try {
    const { sessionId } = req.params

    const result = await startSession(sessionId)

    res.json({
      sessionId: result.sessionId,
      inputStreamUrl: result.inputStreamUrl,
      outputStreamUrl: result.outputStreamUrl,
    })
  } catch (err) {
    console.error(`Error connecting to session ${req.params.sessionId}:`, err)
    res.status(500).json({ error: `Failed to connect to session` })
  }
})

// Disconnect from session (stop container but keep it)
app.post(`/api/sessions/:sessionId/disconnect`, async (req, res) => {
  try {
    const { sessionId } = req.params

    cleanupSession(sessionId)
    await stopContainer(sessionId)

    res.json({ success: true })
  } catch (err) {
    console.error(`Error disconnecting session ${req.params.sessionId}:`, err)
    res.status(500).json({ error: `Failed to disconnect session` })
  }
})

// Resize terminal
app.post(`/api/sessions/:sessionId/resize`, async (req, res) => {
  try {
    const { sessionId } = req.params
    const { cols, rows } = req.body as { cols: number; rows: number }

    await resizeContainer(sessionId, cols, rows)

    res.json({ success: true })
  } catch (err) {
    console.error(`Error resizing session ${req.params.sessionId}:`, err)
    res.status(500).json({ error: `Failed to resize session` })
  }
})

// Delete a session permanently
app.delete(`/api/sessions/:sessionId`, async (req, res) => {
  try {
    const { sessionId } = req.params

    cleanupSession(sessionId)
    await deleteContainer(sessionId)

    res.json({ success: true })
  } catch (err) {
    console.error(`Error deleting session ${req.params.sessionId}:`, err)
    res.status(500).json({ error: `Failed to delete session` })
  }
})

// List all sessions
app.get(`/api/sessions`, async (_req, res) => {
  try {
    const sessions = listSessions().map((s) => ({
      ...s,
      isActive: isSessionActive(s.sessionId),
      inputStreamUrl: `${DS_SERVER_URL}/v1/stream/terminal/${s.sessionId}/input`,
      outputStreamUrl: `${DS_SERVER_URL}/v1/stream/terminal/${s.sessionId}/output`,
    }))

    res.json({ sessions })
  } catch (err) {
    console.error(`Error listing sessions:`, err)
    res.status(500).json({ error: `Failed to list sessions` })
  }
})

// Start server
async function main() {
  // Restore any existing containers from Docker
  await restoreExistingSessions()

  app.listen(PORT, () => {
    console.log(`Web Terminal server listening on port ${PORT}`)
    console.log(`Using Durable Streams server at ${DS_SERVER_URL}`)
  })
}

main().catch(console.error)
