/**
 * Combined server for Docker deployments.
 * Serves both the test-ui static files and the durable streams API.
 */

import { createServer, request as httpRequest } from "node:http"
import { readFile } from "node:fs/promises"
import { resolve, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  DurableStreamTestServer,
  createRegistryHooks,
} from "./packages/server/dist/index.js"

const __dirname = fileURLToPath(new URL(`.`, import.meta.url))
const UI_DIST = resolve(__dirname, `packages/test-ui/dist`)
const PORT = parseInt(process.env.PORT || `8787`, 10)
const HOST = process.env.HOST || `0.0.0.0`
const STREAM_PORT = parseInt(process.env.STREAM_PORT || `8788`, 10)
const DATA_DIR = process.env.DATA_DIR || undefined

// Create the stream server on an internal port
const streamServer = new DurableStreamTestServer({
  port: STREAM_PORT,
  host: `127.0.0.1`,
  dataDir: DATA_DIR,
})

// Start the stream server
const streamUrl = await streamServer.start()
console.log(`✓ Stream server running at ${streamUrl}`)
if (DATA_DIR) {
  console.log(`  Data directory: ${DATA_DIR}`)
}

// Add registry hooks
const publicUrl = process.env.PUBLIC_URL || `http://localhost:${PORT}`
const hooks = createRegistryHooks(streamServer.store, publicUrl)
streamServer.options.onStreamCreated = hooks.onStreamCreated
streamServer.options.onStreamDeleted = hooks.onStreamDeleted

// MIME types for static files
const MIME_TYPES = {
  ".html": `text/html`,
  ".js": `application/javascript`,
  ".css": `text/css`,
  ".json": `application/json`,
  ".png": `image/png`,
  ".jpg": `image/jpeg`,
  ".svg": `image/svg+xml`,
  ".ico": `image/x-icon`,
}

// Helper to get MIME type
function getMimeType(filePath) {
  const ext = filePath.substring(filePath.lastIndexOf(`.`))
  return MIME_TYPES[ext] || `application/octet-stream`
}

// Helper to serve static files
async function serveStaticFile(filePath, res) {
  try {
    const content = await readFile(filePath)
    res.writeHead(200, {
      "content-type": getMimeType(filePath),
      "cache-control": `public, max-age=3600`,
    })
    res.end(content)
  } catch (err) {
    // If file not found, serve index.html for client-side routing
    try {
      const indexPath = join(UI_DIST, `index.html`)
      const content = await readFile(indexPath)
      res.writeHead(200, {
        "content-type": `text/html`,
      })
      res.end(content)
    } catch {
      res.writeHead(404, { "content-type": `text/plain` })
      res.end(`Not found`)
    }
  }
}

// Helper to proxy requests to the stream server
function proxyToStreamServer(req, res) {
  const proxyReq = httpRequest(
    {
      hostname: `127.0.0.1`,
      port: STREAM_PORT,
      path: req.url,
      method: req.method,
      headers: req.headers,
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers)
      proxyRes.pipe(res)
    }
  )

  proxyReq.on(`error`, (err) => {
    console.error(`Proxy error:`, err)
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": `text/plain` })
      res.end(`Internal server error`)
    }
  })

  req.pipe(proxyReq)
}

// Create the combined HTTP server
const server = createServer(async (req, res) => {
  const url = req.url || `/`

  // Handle stream API requests - proxy to internal stream server
  if (url.startsWith(`/v1/stream/`)) {
    proxyToStreamServer(req, res)
    return
  }

  // Handle static files for the UI
  let filePath
  if (url === `/` || url === `/index.html`) {
    filePath = join(UI_DIST, `index.html`)
  } else {
    // Remove query string and serve the file
    const cleanUrl = url.split(`?`)[0]
    filePath = join(UI_DIST, cleanUrl)
  }

  await serveStaticFile(filePath, res)
})

server.listen(PORT, HOST, () => {
  console.log(`✓ Combined server running at http://${HOST}:${PORT}`)
  console.log(`  - Test UI: http://${HOST}:${PORT}`)
  console.log(`  - Stream API: http://${HOST}:${PORT}/v1/stream/`)
  console.log(`\nPress Ctrl+C to stop the server`)
})

// Handle graceful shutdown
process.on(`SIGINT`, async () => {
  console.log(`\nShutting down server...`)
  server.close()
  await streamServer.stop()
  process.exit(0)
})

process.on(`SIGTERM`, async () => {
  console.log(`\nShutting down server...`)
  server.close()
  await streamServer.stop()
  process.exit(0)
})
