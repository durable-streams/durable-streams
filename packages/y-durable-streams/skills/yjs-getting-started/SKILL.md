---
name: yjs-getting-started
description: >
  First-time setup for @durable-streams/y-durable-streams. Install peer deps,
  start dev servers (DurableStreamTestServer + YjsServer), create a collaborative
  Y.Doc, connect with YjsProvider, verify sync, add awareness for presence.
  Load when setting up Yjs collaborative editing for the first time.
type: lifecycle
library: durable-streams
library_version: "0.2.3"
sources:
  - "durable-streams/durable-streams:packages/y-durable-streams/src/yjs-provider.ts"
  - "durable-streams/durable-streams:packages/y-durable-streams/src/server/yjs-server.ts"
  - "durable-streams/durable-streams:packages/y-durable-streams/README.md"
---

# Durable Streams — Yjs Getting Started

Sync Yjs documents over HTTP durable streams. No WebSocket infrastructure
needed — uses standard HTTP with SSE or long-poll transport.

## Install

```bash
npm install @durable-streams/y-durable-streams yjs y-protocols lib0
```

`yjs`, `y-protocols`, and `lib0` are peer dependencies — missing them causes
runtime import errors.

For the dev server (not needed if using Electric Cloud):

```bash
npm install -D @durable-streams/server
```

## Start dev servers

Two servers are needed: a Durable Streams storage server and a Yjs protocol
server that sits in front of it.

```typescript
import { DurableStreamTestServer } from "@durable-streams/server"
import { YjsServer } from "@durable-streams/y-durable-streams/server"

// 1. Storage server
const dsServer = new DurableStreamTestServer({ port: 4437 })
await dsServer.start()

// 2. Yjs protocol server (proxies to storage server)
const yjsServer = new YjsServer({
  port: 4438,
  dsServerUrl: `http://localhost:4437`,
})
await yjsServer.start()

console.log(`Yjs server ready at http://localhost:4438`)
```

## Create a collaborative document

```typescript
import { YjsProvider } from "@durable-streams/y-durable-streams"
import * as Y from "yjs"

const doc = new Y.Doc()

const provider = new YjsProvider({
  doc,
  baseUrl: "http://localhost:4438/v1/yjs/my-service",
  docId: "my-doc",
})

provider.on("synced", (synced) => {
  if (synced) {
    console.log("Document synced with server")
    // Edit the document — changes sync automatically
    doc.getText("content").insert(0, "Hello from Yjs!")
  }
})
```

`baseUrl` is the service root. The provider builds URLs as
`{baseUrl}/docs/{docId}` internally — do not include `/docs/` in baseUrl.

## Add presence

```typescript
import { Awareness } from "y-protocols/awareness"

const awareness = new Awareness(doc)
awareness.setLocalStateField("user", {
  name: "Alice",
  color: "#ff0000",
})

const provider = new YjsProvider({
  doc,
  baseUrl: "http://localhost:4438/v1/yjs/my-service",
  docId: "my-doc",
  awareness,
})

// Listen for remote users
awareness.on("change", () => {
  const users = Array.from(awareness.getStates().values())
    .filter((s) => s?.user)
    .map((s) => s.user.name)
  console.log("Online:", users)
})
```

Use `setLocalStateField("user", ...)` (merges) not `setLocalState(...)` (replaces).
`setLocalState` overwrites all awareness fields, breaking cursor tracking or
other awareness data set by editor bindings.

## Common Mistakes

### CRITICAL Missing peer dependencies

Wrong:

```bash
npm install @durable-streams/y-durable-streams
```

Correct:

```bash
npm install @durable-streams/y-durable-streams yjs y-protocols lib0
```

Source: packages/y-durable-streams/package.json peerDependencies

### HIGH Including `/docs/` in baseUrl

Wrong:

```typescript
new YjsProvider({
  doc,
  baseUrl: "http://localhost:4438/v1/yjs/my-service/docs/my-doc",
  docId: "my-doc",
})
```

Correct:

```typescript
new YjsProvider({
  doc,
  baseUrl: "http://localhost:4438/v1/yjs/my-service",
  docId: "my-doc",
})
```

The provider appends `/docs/{docId}` internally. Doubling `/docs/` produces 404s.

Source: packages/y-durable-streams/src/yjs-provider.ts docUrl()

### HIGH Starting YjsServer without a backing DS server

```typescript
// This will fail — YjsServer needs a running DS server
const yjsServer = new YjsServer({
  port: 4438,
  dsServerUrl: "http://localhost:4437", // Must be running first
})
```

YjsServer proxies all storage operations to the DS server. Start
`DurableStreamTestServer` (or Caddy) before starting `YjsServer`.

## See also

- [yjs-editors](../yjs-editors/SKILL.md) — TipTap and CodeMirror integration
- [yjs-sync](../yjs-sync/SKILL.md) — Provider lifecycle, events, error recovery
- [yjs-server](../yjs-server/SKILL.md) — Production deployment with Caddy or Electric Cloud
