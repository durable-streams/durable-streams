# Durable Streams CLI

A command-line tool for interacting with durable streams.

## Installation

### From npm

```bash
# Global installation
npm install -g @durable-streams/cli

# Or run directly with npx
npx @durable-streams/cli create my-stream
npx @durable-streams/cli read my-stream
```

### From source (for development)

```bash
# Clone the repository
git clone https://github.com/durable-streams/durable-streams.git
cd durable-streams

# Install dependencies
pnpm install

# Build the CLI
pnpm build

# Link globally for development (uses tsx, no rebuild needed)
cd packages/cli
pnpm link:dev

# Now you can use durable-stream-dev anywhere
durable-stream-dev create my-stream
```

## Quick Start

The easiest way to get started is to run the local development server and use the CLI:

### Terminal 1: Start the local server

```bash
pnpm start:dev
```

This will start a Durable Streams server at `http://localhost:4437` with live reloading.

### Terminal 2: Use the CLI

```bash
# Set the server URL (optional, defaults to http://localhost:4437)
export STREAM_URL=http://localhost:4437

# Create a stream
durable-stream-dev create my-stream

# Write to the stream
durable-stream-dev write my-stream "Hello, world!"

# Read from the stream (follows live)
durable-stream-dev read my-stream
```

## Usage

### Environment Variables

- `STREAM_URL` - Base URL of the stream server (default: `http://localhost:4437`)

### Write Options

- `--content-type <type>` - Content-Type for the message (default: `application/octet-stream`)
- `--json` - Shorthand for `--content-type application/json`

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

# Specify content type
durable-stream-dev write <stream_id> '{"key": "value"}' --content-type application/json

# Shorthand for JSON
durable-stream-dev write <stream_id> '{"key": "value"}' --json
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
export STREAM_URL=http://localhost:4437
durable-stream-dev create test-stream

# Terminal 3: Start reading (will show data as it arrives)
export STREAM_URL=http://localhost:4437
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
