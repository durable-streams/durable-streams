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
    - "../caddy-plugin/README.md"
    - "../caddy-plugin/install.sh"
    - "../cli/README.md"
    - "../../README.md"
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
- **Endpoint**: http://localhost:4437/v1/stream/*
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

## HTTPS Setup (Optional)

For local HTTPS with trusted certificates:

### 1. Trust Caddy's Root CA

Run once per machine to install Caddy's certificate authority:

```bash
durable-streams-server trust
```

This adds Caddy's root CA to your system trust store. You may be prompted for your password.

**Check if already trusted:**

```bash
# macOS
security find-certificate -a -c "Caddy" ~/Library/Keychains/login.keychain-db

# Linux (varies by distro)
ls /usr/local/share/ca-certificates/ | grep -i caddy
```

### 2. Create Caddyfile with HTTPS

```caddyfile
{
  admin off
}

localhost:4437 {
  route /v1/stream/* {
    durable_streams
  }
}
```

### 3. Run with Config

```bash
durable-streams-server run --config Caddyfile
```

Now https://localhost:4437 works with a trusted certificate.

## Running Alongside Your App

When your app runs on a standard port (3000, 5173, etc.), use a separate port for durable-streams to avoid conflicts.

### Option 1: Default Port (Recommended)

Keep durable-streams on the default port 4437:

```bash
# Terminal 1: Your app
npm run dev  # Runs on localhost:3000

# Terminal 2: Durable streams
durable-streams-server dev  # Runs on localhost:4437
```

Your app connects to `http://localhost:4437/v1/stream/...`

### Option 2: Custom Port via Caddyfile

Create `Caddyfile.dev`:

```caddyfile
{
  admin off
  auto_https off
}

:8787 {
  route /v1/stream/* {
    durable_streams
  }
}
```

Run:

```bash
durable-streams-server run --config Caddyfile.dev
```

### Option 3: Reverse Proxy Through Your App

If you want streams accessible through your app's domain, add a proxy route in your dev server (Vite, Next.js, etc.).

**Vite (vite.config.ts):**

```typescript
export default defineConfig({
  server: {
    proxy: {
      '/v1/stream': {
        target: 'http://localhost:4437',
        changeOrigin: true,
      },
    },
  },
})
```

**Next.js (next.config.js):**

```javascript
module.exports = {
  async rewrites() {
    return [
      {
        source: '/v1/stream/:path*',
        destination: 'http://localhost:4437/v1/stream/:path*',
      },
    ]
  },
}
```

Now your app can use `/v1/stream/...` without CORS issues.

## Persistent Storage (File-Backed)

For data that survives restarts, use file-backed storage:

```caddyfile
{
  admin off
  auto_https off
}

:4437 {
  route /v1/stream/* {
    durable_streams {
      data_dir ./data
    }
  }
}
```

Data is stored in `./data/` using LMDB.

## Configuration Options

Full Caddyfile options:

```caddyfile
:4437 {
  route /v1/stream/* {
    durable_streams {
      data_dir ./data              # Enable file-backed storage
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
export STREAM_URL=http://localhost:4437/v1/stream

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
2. Use a reverse proxy (see above) to serve from same origin
3. Verify the server is running: `curl http://localhost:4437/v1/stream/test`

### Certificate Not Trusted

If HTTPS shows certificate warnings:

```bash
# Re-run trust command
durable-streams-server trust

# Restart your browser to pick up new certs
```

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
  url: "http://localhost:4437/v1/stream/my-stream",
  live: true,
})

res.subscribeJson(async (batch) => {
  console.log("Received:", batch.items)
})

// Create and write to a stream
const handle = await DurableStream.create({
  url: "http://localhost:4437/v1/stream/my-stream",
  contentType: "application/json",
})

await handle.append(JSON.stringify({ event: "hello" }))
```

## Next Steps

- See the [durable-streams skill](../durable-streams/SKILL.md) for client API details
- See the [durable-state skill](../durable-state/SKILL.md) for state synchronization
