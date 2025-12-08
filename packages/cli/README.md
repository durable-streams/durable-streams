# Durable Streams CLI

A command-line tool for interacting with durable streams.

## Installation

### Local Development

```bash
# Install dependencies
pnpm install

# Build the CLI (for production bin)
pnpm build
```

### Global Installation for Development

For development, you can link the CLI globally with live TypeScript execution (no rebuild needed):

```bash
# From the CLI package directory
pnpm link:dev

# Now you can use durable-stream-dev anywhere
# Changes to src/index.ts are immediately available
durable-stream-dev create my-stream
```

This uses `tsx` to run the TypeScript source directly, so you see changes immediately without rebuilding.

## Quick Start

The easiest way to get started is to run the local development server and use the CLI:

### Terminal 1: Start the local server

```bash
pnpm start:dev
```

This will start a Durable Streams server at `http://localhost:8787` with live reloading.

### Terminal 2: Use the CLI

```bash
# Set the server URL (optional, defaults to http://localhost:8787)
export STREAM_URL=http://localhost:8787

# Create a stream
durable-stream-dev create my-stream

# Write to the stream
durable-stream-dev write my-stream "Hello, world!"

# Read from the stream (follows live)
durable-stream-dev read my-stream
```

## Usage

### Environment Variables

- `STREAM_URL` - Base URL of the stream server (default: `http://localhost:8787`)

### Commands

#### Create a stream

```bash
durable-stream-dev create <stream_id>
```

#### Write to a stream

```bash
# Write content as arguments
durable-stream-dev write <stream_id> "Hello, world!"

# Pipe content from stdin
echo "Hello from stdin" | durable-stream-dev write <stream_id>
cat file.txt | durable-stream-dev write <stream_id>
```

#### Read from a stream

```bash
# Follows the stream and outputs new data to stdout
durable-stream-dev read <stream_id>
```

#### Delete a stream

```bash
durable-stream-dev delete <stream_id>
```

## Complete Example Workflow

```bash
# Terminal 1: Start the local development server
pnpm start:dev

# Terminal 2: Set up the stream
export STREAM_URL=http://localhost:8787
durable-stream-dev create test-stream

# Terminal 3: Start reading (will show data as it arrives)
export STREAM_URL=http://localhost:8787
durable-stream-dev read test-stream

# Back in Terminal 2: Write data and watch it appear in Terminal 3
durable-stream-dev write test-stream "First message"
durable-stream-dev write test-stream "Second message"
echo "Piped content!" | durable-stream-dev write test-stream
```

## Development

```bash
# Start the example server with live reloading
pnpm start:dev

# Watch mode for CLI development (rebuilds dist/)
pnpm dev

# Build
pnpm build

# Link globally for development (uses tsx, no rebuild needed)
pnpm link:dev
```
