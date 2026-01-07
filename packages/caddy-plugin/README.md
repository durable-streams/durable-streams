# Durable Streams Caddy Server

A production-ready Durable Streams server implementation built as a Caddy v2 plugin.

## Features

- **Full Protocol Support**: Implements the complete Durable Streams protocol
- **Storage Options**: In-memory and file-backed (LMDB) storage
- **Live Modes**: Long-polling and Server-Sent Events (SSE)
- **JSON Mode**: Native JSON array handling with flattening
- **Production Ready**: Built on Caddy's battle-tested HTTP server

## Installation

### Quick Install (Recommended)

**macOS & Linux:**

```bash
curl -sSL https://raw.githubusercontent.com/durable-streams/durable-streams/main/packages/caddy-plugin/install.sh | sh
```

**Install specific version:**

```bash
curl -sSL https://raw.githubusercontent.com/durable-streams/durable-streams/main/packages/caddy-plugin/install.sh | sh -s v0.1.0
```

**Custom install directory:**

```bash
INSTALL_DIR=~/.local/bin curl -sSL https://raw.githubusercontent.com/durable-streams/durable-streams/main/packages/caddy-plugin/install.sh | sh
```

### Manual Download

Download the latest release for your platform from [GitHub Releases](https://github.com/durable-streams/durable-streams/releases):

**macOS (Apple Silicon):**

```bash
curl -L https://github.com/durable-streams/durable-streams/releases/latest/download/durable-streams-server_<VERSION>_darwin_arm64.tar.gz | tar xz
sudo mv durable-streams-server /usr/local/bin/
```

**macOS (Intel):**

```bash
curl -L https://github.com/durable-streams/durable-streams/releases/latest/download/durable-streams-server_<VERSION>_darwin_amd64.tar.gz | tar xz
sudo mv durable-streams-server /usr/local/bin/
```

**Linux (x86_64):**

```bash
curl -L https://github.com/durable-streams/durable-streams/releases/latest/download/durable-streams-server_<VERSION>_linux_amd64.tar.gz | tar xz
sudo mv durable-streams-server /usr/local/bin/
```

**Windows:**

Download the `.zip` file from releases and extract to your PATH.

### Build from Source

```bash
go build -o durable-streams-server ./cmd/caddy
```

## Quick Start

### Dev Mode (Zero Config)

Just run:

```bash
durable-streams-server dev
```

This starts the server with sensible defaults:

- 🌐 **URL**: http://localhost:4437
- 📍 **Endpoint**: http://localhost:4437/v1/stream/\*
- 💾 **Storage**: In-memory (no persistence)
- ⚡ **Zero config**: No Caddyfile needed

Perfect for development and testing!

### Production Mode

Create a `Caddyfile` for production with persistent storage:

```caddyfile
{
	admin off
}

:4437 {
	route /v1/stream/* {
		durable_streams {
			data_dir ./data
		}
	}
}
```

Start the server:

```bash
durable-streams-server run --config Caddyfile
```

## Configuration

### In-Memory Mode (Default)

```caddyfile
:8787 {
	route /v1/stream/* {
		durable_streams
	}
}
```

### File-Backed Mode (LMDB)

```caddyfile
:8787 {
	route /v1/stream/* {
		durable_streams {
			data_dir ./data
		}
	}
}
```

### Custom Timeouts

```caddyfile
:8787 {
	route /v1/stream/* {
		durable_streams {
			data_dir ./data
			long_poll_timeout 30s
			sse_reconnect_interval 120s
		}
	}
}
```

## Development

### Running Tests

```bash
# Go tests
go test ./...

# Conformance tests
pnpm test:run
```

### Building

```bash
pnpm build
# or
go build -o caddy ./cmd/caddy
```

## Releasing

Releases are automated via GoReleaser when a tag is pushed:

```bash
# Create and push a tag
git tag caddy-v0.1.0
git push origin caddy-v0.1.0
```

This will:

1. Build binaries for all platforms
2. Create GitHub release with artifacts
3. Generate checksums
4. Auto-generate changelog

## Architecture

- **Handler**: HTTP request routing and protocol implementation
- **Store**: Abstract storage interface
  - **MemoryStore**: In-memory implementation for development
  - **FileStore**: LMDB-backed implementation for production
- **Cursor Management**: CDN cache collision prevention
- **Long-Poll Manager**: Efficient waiting for new messages

## License

Apache-2.0
