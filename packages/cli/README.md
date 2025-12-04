# Durable Streams CLI

A command-line tool for interacting with durable streams.

## Installation

```bash
pnpm install
pnpm build
```

## Usage

### Environment Variables

- `STREAM_URL` - Base URL of the stream server (default: `http://localhost:8787`)

### Commands

#### Create a stream

```bash
node dist/index.js create my-stream
```

#### Write to a stream

```bash
# Write content as arguments
node dist/index.js write my-stream "Hello, world!"

# Pipe content from stdin
echo "Hello from stdin" | node dist/index.js write my-stream
cat file.txt | node dist/index.js write my-stream
```

#### Read from a stream (follows live)

```bash
# Follows the stream and outputs new data to stdout
node dist/index.js read my-stream
```

#### Delete a stream

```bash
node dist/index.js delete my-stream
```

## Example Workflow

```bash
# Terminal 1: Start the server
cd ../durable-streams-server
pnpm dev

# Terminal 2: Create and write to a stream
export STREAM_URL=http://localhost:8787
node dist/index.js create test-stream
node dist/index.js write test-stream "First message"

# Terminal 3: Follow the stream
export STREAM_URL=http://localhost:8787
node dist/index.js read test-stream
# You'll see "First message" and then it will wait for new data

# Back in Terminal 2: Write more data
node dist/index.js write test-stream "Second message"
# Terminal 3 will immediately show "Second message"
```

## Development

```bash
# Watch mode
pnpm dev

# Build
pnpm build
```
