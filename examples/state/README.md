# Durable Streams State Examples

This directory contains single-file HTML examples demonstrating the Durable Streams State Protocol.

## Prerequisites

1. **Build the packages:**

   ```bash
   # From the monorepo root
   pnpm install
   pnpm build
   ```

2. **Start the Durable Streams server:**

   ```bash
   # From the monorepo root (in a separate terminal)
   pnpm --filter @durable-streams/server dev
   ```

   The server should be running on `http://localhost:4437`

## Running Examples

We use Vite for fast development:

```bash
# From this directory (examples/state)
cd examples/state
pnpm install
pnpm dev
```

This will:

- Start Vite dev server (usually on http://localhost:5173)
- Open the example in your browser automatically
- Hot reload on changes

## Examples

### background-jobs/

**Background Jobs with Progress Tracking**

A demo of the state protocol showing multiple concurrent background jobs with:

- Real-time progress updates (0-100%)
- Status messages and state transitions
- Randomized job behavior (tasks, duration, error rates)
- Live statistics and beautiful UI
- Multiple simultaneous jobs

**Key Concepts Demonstrated:**

- StreamDB collection setup with Zod schema validation
- Insert events to create new jobs
- Update events for progress tracking
- Real-time subscriptions with `subscribeChanges()`
- State materialization from event log

**Try it:**

1. Click "Start New Job" to create background tasks
2. Watch jobs progress through stages with status updates
3. Some jobs will succeed, others may fail (~20% error rate)
4. Start multiple jobs simultaneously to see concurrent updates

### wikipedia-events/

**Live Wikipedia EventStreams Dashboard**

A real-time demo showing Wikipedia edits from around the world with:

- **Server-side SSE consumption** from Wikimedia EventStreams API
- **Client-side Solid.js app** with @tanstack/solid-db reactive queries
- **Faceted filtering** by language, event type, bot/human, and namespace
- **Real-time statistics** dashboard with events/sec, top languages, and more
- **Direct links** to Wikipedia pages and diffs

**Prerequisites:**

In addition to the standard prerequisites above, you need to:

1. Start the Wikipedia worker:
   ```bash
   # In a separate terminal
   cd examples/state/wikipedia-worker
   pnpm dev
   ```

**Run the example:**

```bash
cd examples/state/wikipedia-events
pnpm install
pnpm dev
```

The app will open at http://localhost:5174

**Key Concepts Demonstrated:**

- **External SSE integration**: Consuming third-party event streams (Wikipedia)
- **Server-side stream writing**: Worker transforms and writes events to durable stream
- **Solid.js reactivity**: Fine-grained reactive UI with @tanstack/solid-db
- **Client-side filtering**: Faceted search across multiple dimensions
- **Real-time aggregation**: Live statistics computed from streaming data
- **Multi-process architecture**: Separate worker, server, and client processes

**Try it:**

1. Watch live Wikipedia edits streaming in from around the world
2. Filter by language to see edits from specific Wikipedia editions (en, es, fr, etc.)
3. Toggle bot edits on/off to see human vs automated contributions
4. Filter by event type (edits, new pages, log events, categorization)
5. Click any event to view the actual Wikipedia page or diff
6. Observe real-time statistics updating as events flow through

## Architecture

Examples demonstrate different architectural patterns:

**background-jobs/**

- **Single-file simplicity**: All HTML, CSS, and JS in one file
- **Client-side events**: Events created in the browser

**wikipedia-events/** and **wikipedia-worker/**

- **Multi-file Solid.js app**: Proper component architecture with TypeScript
- **Server-side events**: Worker (../wikipedia-worker) consumes SSE and writes to stream
- **Framework integration**: Showcases Solid.js with @tanstack/solid-db

**Common Concepts:**

- **State Protocol**: Event-driven state synchronization
- **StreamDB**: Reactive collections backed by durable streams
- **Zod Validation**: Type-safe schema validation (Zod supports Standard Schema v1)
- **Real-time updates**: Live UI updates as events flow through the stream

## Troubleshooting

**"Failed to connect" error:**

- Make sure the Durable Streams server is running on port 4437
- Check that packages are built with `pnpm build` from the monorepo root

**Vite won't start:**

- Run `pnpm install` in the examples directory first
- Make sure the parent packages are built

**Module resolution errors:**

- Ensure you've run `pnpm install` in the monorepo root
- The workspace dependencies should resolve automatically
