---
name: durable-streams-dev-setup
description: Guide for setting up a Durable Streams development environment. Use when helping developers install the server, configure HTTPS certificates, or run alongside their app server.
triggers:
  - "durable streams setup"
  - "install durable streams"
  - "durable streams server"
  - "dev environment"
  - "caddy trust"
  - "local development"
metadata:
  sources:
    - "../../../caddy-plugin/README.md"
    - "../../../caddy-plugin/install.sh"
    - "../../../cli/README.md"
    - "../../../../README.md"
---

# Durable Streams Dev Environment Setup

Set up a local Durable Streams server for development. The server is built on Caddy and supports both quick dev mode and production-like configurations.

## Quick Start (Zero Config)

### 1. Install the Server

**macOS & Linux (recommended):**

```bash
curl -sSL https://raw.githubusercontent.com/durable-streams/durable-streams/main/packages/caddy-plugin/install.sh | sh
```

**Custom install directory:**

```bash
INSTALL_DIR=~/.local/bin curl -sSL https://raw.githubusercontent.com/durable-streams/durable-streams/main/packages/caddy-plugin/install.sh | sh
```

**Manual download:** Get the binary from [GitHub Releases](https://github.com/durable-streams/durable-streams/releases) for your platform.

### 2. Run Dev Mode

```bash
durable-streams-server dev
```

This starts immediately with:

- **URL**: http://localhost:4437
- **Endpoint**: http://localhost:4437/v1/stream/\*
- **Storage**: In-memory (no persistence)
- **No config file needed**

### 3. Test It Works

```bash
# Create a stream
curl -X PUT http://localhost:4437/v1/stream/test

# Write data
curl -X POST http://localhost:4437/v1/stream/test -d "hello world"

# Read data
curl "http://localhost:4437/v1/stream/test?offset=-1"
```

## HTTPS Setup (Recommended)

HTTPS is recommended for local development because browsers limit HTTP/1.1 to 6 concurrent connections per origin. With durable-streams, you'll often have multiple live streams open simultaneously, and this limit can cause connection queueing. HTTPS enables HTTP/2 multiplexing, allowing unlimited concurrent streams over a single connection.

### 1. Create a `Caddyfile`:

```caddyfile
localhost:4437 {
  route /v1/stream/* {
    durable_streams {
      data_dir .durable-streams
    }
  }
}
```

### 2. Add to `.gitignore`:

```bash
echo ".durable-streams" >> .gitignore
```

### 3. Run:

```bash
durable-streams-server run --config Caddyfile
```

On first run, Caddy automatically:

1. Generates a local CA certificate
2. Installs it in your system trust store (may prompt for password once)
3. Issues a certificate for `localhost`
4. Enables HTTP/2 and HTTP/3

Your app connects to `https://localhost:4437/v1/stream/...`

**If automatic trust fails** (rare, usually permissions), manually trust the CA:

- **macOS**: `~/Library/Application Support/Caddy/pki/authorities/local/root.crt` - double-click to add to Keychain
- **Linux**: Copy to `/usr/local/share/ca-certificates/` and run `sudo update-ca-certificates`

**HTTP fallback**: If you don't need multiple concurrent streams, the `dev` command uses HTTP:

```bash
durable-streams-server dev  # HTTP on localhost:4437
```

## Running Alongside Your App

When your app runs on a standard port (3000, 5173, etc.), use a separate port for durable-streams to avoid conflicts.

### Option 1: Two Terminals

```bash
# Terminal 1: Your app
npm run dev  # Runs on localhost:3000

# Terminal 2: Durable streams (HTTPS)
durable-streams-server run --config Caddyfile  # Runs on https://localhost:4437
```

Your app connects to `https://localhost:4437/v1/stream/...`

### Option 2: Single Dev Command (Recommended)

Run both servers with one command using `concurrently`:

```bash
npm install -D concurrently
```

Create `Caddyfile` in your project root (if not already):

```caddyfile
localhost:4437 {
  route /v1/stream/* {
    durable_streams {
      data_dir .durable-streams
    }
  }
}
```

Add `.durable-streams` to `.gitignore`, then add to `package.json`:

```json
{
  "scripts": {
    "dev": "concurrently \"npm run dev:app\" \"npm run dev:streams\"",
    "dev:app": "vite",
    "dev:streams": "durable-streams-server run --config Caddyfile"
  }
}
```

Now `npm run dev` starts everything:

```bash
npm run dev
# [0] vite dev server running at http://localhost:5173
# [1] durable-streams server running at https://localhost:4437
```

**Alternative with npm-run-all:**

```bash
npm install -D npm-run-all
```

```json
{
  "scripts": {
    "dev": "run-p dev:*",
    "dev:app": "vite",
    "dev:streams": "durable-streams-server run --config Caddyfile"
  }
}
```

**With wait-on (start app after server is ready):**

```bash
npm install -D concurrently wait-on
```

```json
{
  "scripts": {
    "dev": "concurrently \"npm run dev:streams\" \"npm run dev:app\"",
    "dev:app": "wait-on tcp:4437 && vite",
    "dev:streams": "durable-streams-server run --config Caddyfile"
  }
}
```

## In-Memory Storage (Optional)

By default, the Caddyfile examples use file-backed storage in `.durable-streams/`. If you want in-memory storage (data lost on restart), omit the `data_dir`:

```caddyfile
localhost:4437 {
  route /v1/stream/* {
    durable_streams
  }
}
```

Or use the zero-config dev command which is always in-memory:

```bash
durable-streams-server dev
```

## Configuration Options

Full Caddyfile options:

```caddyfile
localhost:4437 {
  route /v1/stream/* {
    durable_streams {
      data_dir .durable-streams    # File-backed storage (recommended)
      max_file_handles 100         # LMDB file handle limit
      long_poll_timeout 30s        # Long-poll wait time
      sse_reconnect_interval 60s   # SSE retry interval
    }
  }
}
```

## CLI Tools

Install the CLI for easy stream management:

```bash
npm install -g @durable-streams/cli
```

Or use locally in your project:

```bash
npm install @durable-streams/cli
```

**Commands:**

```bash
# Set server URL
export STREAM_URL=https://localhost:4437/v1/stream

# Create a stream
durable-stream create my-stream

# Write data
durable-stream write my-stream "hello"
echo "piped data" | durable-stream write my-stream

# Read (follows live)
durable-stream read my-stream

# Delete
durable-stream delete my-stream
```

## Common Issues

### Port Already in Use

```bash
# Find what's using port 4437
lsof -i :4437

# Kill it or use a different port in Caddyfile
```

### CORS Errors

The server sets `Access-Control-Allow-Origin: *` by default. If you still see CORS errors:

1. Check you're hitting the durable-streams server, not your app server
2. Verify the server is running: `curl https://localhost:4437/v1/stream/test`
3. Check browser dev tools for the actual error (may be a network issue, not CORS)

### Certificate Not Trusted

If HTTPS shows certificate warnings:

1. Restart the server - Caddy re-attempts trust on startup
2. Manually trust the CA certificate:
   - **macOS**: Double-click `~/Library/Application Support/Caddy/pki/authorities/local/root.crt` to add to Keychain
   - **Linux**: `sudo cp ~/.local/share/caddy/pki/authorities/local/root.crt /usr/local/share/ca-certificates/caddy-local.crt && sudo update-ca-certificates`
3. Restart your browser to pick up new certs

### Server Won't Start

```bash
# Check for config errors
durable-streams-server validate --config Caddyfile

# Run with verbose logging
durable-streams-server run --config Caddyfile --debug
```

## TypeScript Client Setup

Once the server is running, connect from your app:

```typescript
import { stream, DurableStream } from "@durable-streams/client"

// Read from a stream
const res = await stream({
  url: "https://localhost:4437/v1/stream/my-stream",
  live: true,
})

res.subscribeJson(async (batch) => {
  console.log("Received:", batch.items)
})

// Create and write to a stream
const handle = await DurableStream.create({
  url: "https://localhost:4437/v1/stream/my-stream",
  contentType: "application/json",
})

await handle.append(JSON.stringify({ event: "hello" }))
```

## Next Steps

- See the [durable-streams skill](../durable-streams/SKILL.md) for client API details
- See the [durable-state skill](../durable-state/SKILL.md) for state synchronization
