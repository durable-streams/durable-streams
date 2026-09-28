# StreamDB Demo

Three entity types (messages, presence, agents) multiplexed on a single [Durable Stream](https://durablestreams.com) using [StreamDB](https://durablestreams.com/stream-db).

See the [StreamDB blog post](https://electric-sql.com/blog/2026/03/26/stream-db) for more context.

## Setup

### 1. Start a Durable Streams server

Download the latest `durable-streams-server` binary from the [GitHub releases page](https://github.com/durable-streams/durable-streams/releases/latest), then run:

```sh
./durable-streams-server dev
```

This starts an in-memory server on `http://localhost:4437`.

### 2. Create a stream

```sh
npx @durable-streams/cli \
  --url 'http://localhost:4437/v1/stream' \
  --content-type application/json \
  create my-db
```

### 3. Configure environment

```sh
cp .env.template .env
```

Edit `.env` with your stream URL. Set `VITE_STREAM_SECRET` only if your server requires a bearer token:

```
VITE_STREAM_URL="http://localhost:4437/v1/stream/my-db"
VITE_STREAM_SECRET=""
```

### 4. Install and run

```sh
pnpm install
pnpm dev
```

Open http://localhost:5173
