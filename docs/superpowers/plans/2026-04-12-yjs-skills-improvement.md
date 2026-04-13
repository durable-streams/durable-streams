# Yjs Skills Improvement — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve the y-durable-streams skill suite from 1 monolithic skill to 4 focused skills (getting-started, editors, server, refocused sync), add practical TipTap/CodeMirror integration guides with documented anti-patterns, add Electric Cloud coverage, and update the docsite.

**Architecture:** 4 skills under `packages/y-durable-streams/skills/`, each following the existing SKILL.md conventions from `packages/client/skills/`. The `yjs-sync` skill is refocused (not replaced). The docsite at `docs/yjs.md` gets a new "Editor integrations" section and Electric Cloud deployment option.

**Tech Stack:** Markdown (skills), VitePress (docsite)

**Context bloat principle:** Skills are consumed by AI agents with limited context. Every section must earn its place. No redundancy between skills — use `requires:` and "See also" cross-references instead of repeating content.

---

## File map

| Action | Path                                                             | Responsibility                                    |
| ------ | ---------------------------------------------------------------- | ------------------------------------------------- |
| Create | `packages/y-durable-streams/skills/yjs-getting-started/SKILL.md` | First-time full-stack setup                       |
| Create | `packages/y-durable-streams/skills/yjs-editors/SKILL.md`         | TipTap + CodeMirror integration guides            |
| Create | `packages/y-durable-streams/skills/yjs-server/SKILL.md`          | YjsServer, Caddy proxy, Electric Cloud            |
| Modify | `packages/y-durable-streams/skills/yjs-sync/SKILL.md`            | Refocus on provider deep-dive                     |
| Modify | `docs/yjs.md`                                                    | Add editor integrations + Electric Cloud sections |

---

### Task 1: Create `yjs-getting-started` skill

**Files:**

- Create: `packages/y-durable-streams/skills/yjs-getting-started/SKILL.md`

This is the "first 10 minutes" skill. Covers the full stack: install, start servers, create first collaborative doc, verify sync.

- [ ] **Step 1: Create the skill file**

````markdown
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
````

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

````

- [ ] **Step 2: Verify the file exists and is well-formed**

Run: `head -5 packages/y-durable-streams/skills/yjs-getting-started/SKILL.md`
Expected: YAML frontmatter starting with `---`

- [ ] **Step 3: Commit**

```bash
git add packages/y-durable-streams/skills/yjs-getting-started/SKILL.md
git commit -m "feat(y-durable-streams): add yjs-getting-started skill

Covers first-time setup: install, dev servers, first collaborative doc,
awareness for presence."
````

---

### Task 2: Create `yjs-editors` skill

**Files:**

- Create: `packages/y-durable-streams/skills/yjs-editors/SKILL.md`

This is the most critical skill. TipTap section leads with the canonical pattern and documents all 5 recurring bugs. CodeMirror follows the same React lifecycle approach.

- [ ] **Step 1: Create the skill file**

````markdown
---
name: yjs-editors
description: >
  Integrate Yjs collaborative editing with TipTap v3 and CodeMirror 6 over
  durable streams. Canonical React patterns using useState lazy init (not
  useEffect+setState). TipTap: Collaboration + CollaborationCaret extensions,
  -caret not -cursor package. CodeMirror: yCollab binding. Covers awareness
  wiring, multi-document navigation with key={docId}, SSR ssr:false
  requirement. Critical anti-patterns that crash agents documented.
type: core
library: durable-streams
library_version: "0.2.3"
requires:
  - yjs-getting-started
sources:
  - "durable-streams/durable-streams:packages/y-durable-streams/src/yjs-provider.ts"
  - "durable-streams/durable-streams:examples/yjs-demo/src/routes/room.$roomId.tsx"
  - "durable-streams/durable-streams:examples/yjs-demo/src/components/yjs-provider.tsx"
---

This skill builds on durable-streams/yjs-getting-started. Read it first for
install and server setup.

# Durable Streams — Editor Integrations

Wire Yjs + YjsProvider into rich-text and code editors. Both integrations
share the same React lifecycle pattern — the editor-specific code is just
the binding setup.

## React lifecycle pattern (shared by all editors)

All editor integrations MUST use this pattern. The `useState` lazy
initializer constructs objects synchronously on first render. The cleanup
effect destroys them on unmount. No null guards, no intermediate states.

```typescript
import { YjsProvider } from "@durable-streams/y-durable-streams"
import * as Y from "yjs"
import { Awareness } from "y-protocols/awareness"

function CollabEditor({ docId }: { docId: string }) {
  // 1. Construct ALL Yjs objects via useState lazy init — never useEffect
  const [ydoc] = useState(() => new Y.Doc())
  const [awareness] = useState(() => {
    const aw = new Awareness(ydoc)
    aw.setLocalStateField("user", {
      name: localStorage.getItem("userName") || "Anonymous",
      color: localStorage.getItem("userColor") || "#d0bcff",
    })
    return aw
  })
  const [provider] = useState(
    () =>
      new YjsProvider({
        doc: ydoc,
        baseUrl: "https://your-server.com/v1/yjs/my-service",
        docId,
        awareness,
        // connect defaults to true — no need for connect:false + connect()
      })
  )

  // 2. Single cleanup effect — destroy in reverse order
  useEffect(() => {
    return () => {
      provider.destroy()
      awareness.destroy()
      ydoc.destroy()
    }
  }, [provider, awareness, ydoc])

  // 3. Track sync state
  const [synced, setSynced] = useState(false)
  useEffect(() => {
    const handler = (s: boolean) => {
      if (s) setSynced(true)
    }
    provider.on("synced", handler)
    return () => {
      provider.off("synced", handler)
    }
  }, [provider])

  // 4. Editor setup goes here (see TipTap / CodeMirror sections below)
  // ...
}
```
````

### Why `useState(() => ...)` not `useEffect` + `setState(null)`

|                          | `useEffect` + `useState(null)`  | `useState(() => new ...)` |
| ------------------------ | ------------------------------- | ------------------------- |
| Provider on first render | `null`                          | **non-null**              |
| Editor extensions config | needs conditional guards        | always gets valid objects |
| Editor recreations       | twice (without, then with)      | **once**                  |
| Cleanup race             | `setState(null)` = stale render | no intermediate null      |

### Why not `useMemo`

`useMemo` is a caching hint, not a lifecycle primitive. React can evict and
recreate the value without cleanup. `Y.Doc` and `Awareness` need explicit
`.destroy()`. `useState` lazy init + `useEffect` cleanup is the correct
primitive for objects with construction + destruction.

### Multi-document navigation

When navigating between documents, key the component on `docId` so React
fully unmounts and remounts it:

```tsx
function DocPage() {
  const { docId } = Route.useParams()
  return <CollabEditor key={docId} docId={docId} />
}
```

Do NOT reuse ydoc/provider across documents — CRDTs are per-document.

### SSR requirement

Routes using YjsProvider MUST disable SSR. The provider uses `fetch` and
`EventSource` which don't exist server-side.

```tsx
// TanStack Router
export const Route = createFileRoute("/doc/$docId")({
  ssr: false,
  component: DocPage,
})
```

## TipTap v3

### Install

```bash
npm install @tiptap/react @tiptap/starter-kit \
  @tiptap/extension-collaboration @tiptap/extension-collaboration-caret
```

**Do NOT install `@tiptap/extension-collaboration-cursor`** — it's a broken
v3 stub that imports `y-prosemirror` (replaced by `@tiptap/y-tiptap` in v3).
Crashes with `TypeError: Cannot read properties of undefined (reading 'doc')`.

**Do NOT install `y-prosemirror`** — TipTap v3 internalized it. Having both
creates duplicate `ySyncPluginKey` singletons that crash the editor.

### Editor setup

Using the shared lifecycle pattern above, add the editor:

```tsx
import { useEditor, EditorContent } from "@tiptap/react"
import StarterKit from "@tiptap/starter-kit"
import Collaboration from "@tiptap/extension-collaboration"
import CollaborationCaret from "@tiptap/extension-collaboration-caret"

// Inside CollabEditor component, after the shared lifecycle code:

const editor = useEditor({
  extensions: [
    StarterKit.configure({ undoRedo: false }),
    Collaboration.configure({ document: ydoc }),
    CollaborationCaret.configure({
      provider,
      user: {
        name: localStorage.getItem("userName") || "Anonymous",
        color: localStorage.getItem("userColor") || "#d0bcff",
      },
    }),
  ],
  editorProps: {
    attributes: {
      class: "prose max-w-none min-h-[60vh] focus:outline-none",
    },
  },
})

if (!synced) return <p>Connecting...</p>
return <EditorContent editor={editor} />
```

Key points:

- `undoRedo: false` — Yjs has its own undo manager; StarterKit's conflicts
- `CollaborationCaret.configure({ provider })` — provider is always non-null
  because of `useState` lazy init. No conditional guard needed.
- The `document` option takes the `Y.Doc` directly — TipTap creates the
  `Y.XmlFragment` internally

## CodeMirror 6

### Install

```bash
npm install codemirror @codemirror/state @codemirror/view y-codemirror.next
```

### Editor setup

Using the shared lifecycle pattern, add CodeMirror via a ref:

```tsx
import { EditorView, basicSetup } from "codemirror"
import { EditorState } from "@codemirror/state"
import { yCollab } from "y-codemirror.next"

// Inside CollabEditor component, after the shared lifecycle code:

const editorRef = useRef<HTMLDivElement>(null)

useEffect(() => {
  if (!editorRef.current || !synced) return

  const ytext = ydoc.getText("content")
  const state = EditorState.create({
    doc: ytext.toString(),
    extensions: [
      basicSetup,
      EditorView.lineWrapping,
      yCollab(ytext, awareness),
    ],
  })

  const view = new EditorView({ state, parent: editorRef.current })
  return () => view.destroy()
}, [synced, ydoc, awareness])

if (!synced) return <p>Connecting...</p>
return <div ref={editorRef} />
```

Key points:

- `yCollab(ytext, awareness)` handles both document sync and cursor rendering
- Uses `Y.Text` (not `Y.XmlFragment` like TipTap)
- Editor is created after `synced` to avoid rendering stale empty state

## Other editors

**BlockNote** — built on TipTap. Use the same packages and pattern as TipTap
above. BlockNote's `useCreateBlockNote` accepts a `collaboration` option
with `provider` and `fragment` fields.

**Lexical** — use `@lexical/yjs` with `CollaborationPlugin`. Pass the
`YjsProvider` as the provider. Requires `ssr: false` like all Yjs editors.

## Common Mistakes

### CRITICAL Installing `@tiptap/extension-collaboration-cursor` (TipTap)

Wrong:

```bash
npm install @tiptap/extension-collaboration-cursor
```

Correct:

```bash
npm install @tiptap/extension-collaboration-caret
```

The `-cursor` package is a broken v3 stub. It imports from `y-prosemirror`
which uses a different `ySyncPluginKey` singleton than TipTap v3's internal
`@tiptap/y-tiptap`. Crashes with `TypeError: Cannot read properties of
undefined (reading 'doc')`.

Source: TipTap v3 migration, @tiptap/extension-collaboration-caret package

### CRITICAL Using `useEffect` + `useState(null)` for provider (all editors)

Wrong:

```tsx
const [provider, setProvider] = useState<YjsProvider | null>(null)

useEffect(() => {
  const p = new YjsProvider({ doc: ydoc, baseUrl, docId, awareness })
  setProvider(p)
  return () => {
    p.destroy()
    setProvider(null)
  }
}, [ydoc, awareness, docId])

const editor = useEditor(
  {
    extensions: [
      ...(provider ? [CollaborationCaret.configure({ provider })] : []),
    ],
  },
  [provider]
)
```

Correct: Use the `useState(() => ...)` pattern from the lifecycle section above.

On first render `provider` is null. The conditional spread omits the caret
extension. When the effect fires and sets the provider, the editor recreates —
but the teardown/init race crashes intermittently with
`TypeError: Cannot read properties of null (reading 'awareness')`.

Source: Documented in 5+ agent sessions building TipTap + y-durable-streams

### HIGH Using `useMemo` for Y.Doc or Awareness (all editors)

Wrong:

```tsx
const ydoc = useMemo(() => new Y.Doc(), [])
const awareness = useMemo(() => new Awareness(ydoc), [ydoc])
```

Correct: Use `useState(() => ...)` lazy initializers.

`useMemo` is a caching hint. React can evict and recreate the value without
calling cleanup. Leaked `Y.Doc` and `Awareness` instances accumulate
listeners and connections.

### HIGH Not disabling SSR (all editors)

Wrong: Using YjsProvider in a server-rendered route.

Correct: Set `ssr: false` on the route. YjsProvider uses `fetch`/`EventSource`
which don't exist server-side.

### MEDIUM Not keying component on docId for multi-document navigation

Wrong:

```tsx
<CollabEditor docId={docId} />
```

Correct:

```tsx
<CollabEditor key={docId} docId={docId} />
```

Without `key`, React reuses the component. The old ydoc/provider persist
with stale document data. Keying forces full unmount → remount with fresh
Yjs objects.

## See also

- [yjs-getting-started](../yjs-getting-started/SKILL.md) — Install and server setup
- [yjs-sync](../yjs-sync/SKILL.md) — Provider options, events, error recovery
- [yjs-server](../yjs-server/SKILL.md) — Production deployment

````

- [ ] **Step 2: Verify the file exists and is well-formed**

Run: `head -5 packages/y-durable-streams/skills/yjs-editors/SKILL.md`
Expected: YAML frontmatter starting with `---`

- [ ] **Step 3: Commit**

```bash
git add packages/y-durable-streams/skills/yjs-editors/SKILL.md
git commit -m "feat(y-durable-streams): add yjs-editors skill

TipTap v3 and CodeMirror 6 integration guides with canonical React
lifecycle pattern (useState lazy init). Documents 5 recurring agent
bugs including -caret vs -cursor, useEffect anti-pattern, useMemo
lifecycle leak."
````

---

### Task 3: Create `yjs-server` skill

**Files:**

- Create: `packages/y-durable-streams/skills/yjs-server/SKILL.md`

Covers YjsServer options, Caddy reverse proxy setup, compaction, and Electric Cloud as managed alternative.

- [ ] **Step 1: Create the skill file**

```markdown
---
name: yjs-server
description: >
  Deploy Yjs collaborative editing. YjsServer setup with compaction threshold,
  Caddy reverse proxy with flush_interval -1 for SSE, 3-layer architecture
  (Browser → Caddy → YjsServer → DS Server), Electric Cloud managed
  alternative with @electric-sql/cli provisioning. Load when deploying
  y-durable-streams to production or configuring server infrastructure.
type: core
library: durable-streams
library_version: "0.2.3"
requires:
  - yjs-getting-started
sources:
  - "durable-streams/durable-streams:packages/y-durable-streams/src/server/yjs-server.ts"
  - "durable-streams/durable-streams:packages/y-durable-streams/src/server/compaction.ts"
  - "durable-streams/durable-streams:examples/yjs-demo/server.ts"
  - "durable-streams/durable-streams:examples/yjs-demo/Caddyfile"
---

This skill builds on durable-streams/yjs-getting-started. Read it first for
basic setup.

# Durable Streams — Yjs Server Deployment

Three deployment options: dev server for prototyping, Caddy for self-hosted
production, Electric Cloud for managed hosting.

## Architecture
```

Browser (YjsProvider)
│ HTTPS
▼
Caddy reverse proxy (:443)
├─ /v1/stream/_ → Durable Streams storage
└─ /v1/yjs/_ → YjsServer (flush_interval -1)
│ HTTP
▼
DS Server (storage)

````

YjsServer implements the Yjs wire protocol (snapshot discovery, compaction,
awareness routing) and proxies all storage operations to a Durable Streams
server.

## Development

```typescript
import { DurableStreamTestServer } from "@durable-streams/server"
import { YjsServer } from "@durable-streams/y-durable-streams/server"

const dsServer = new DurableStreamTestServer({ port: 4437 })
await dsServer.start()

const yjsServer = new YjsServer({
  port: 4438,
  host: "127.0.0.1",
  dsServerUrl: "http://localhost:4437",
  compactionThreshold: 1024 * 1024, // 1MB (default)
})
await yjsServer.start()
````

### YjsServer options

| Option                | Default         | Description                                         |
| --------------------- | --------------- | --------------------------------------------------- |
| `port`                | —               | Listen port                                         |
| `host`                | `"127.0.0.1"`   | Listen host                                         |
| `dsServerUrl`         | —               | Backing DS server URL                               |
| `compactionThreshold` | `1048576` (1MB) | Trigger compaction after this many bytes of updates |
| `dsServerHeaders`     | `{}`            | Headers sent to the DS server (e.g. auth)           |

### Compaction

When accumulated updates for a document exceed `compactionThreshold`, the
server automatically creates a snapshot. New clients load the snapshot
instead of replaying all updates — keeps initial sync fast. Connected clients
are unaffected.

## Production with Caddy

Download the Caddy binary with the durable_streams plugin from
[GitHub releases](https://github.com/durable-streams/durable-streams/releases).

### Caddyfile

```
:443 {
  route /v1/stream/* {
    durable_streams {
      data_dir ./data
      max_file_handles 200
    }
  }

  route /v1/yjs/* {
    reverse_proxy localhost:4438 {
      flush_interval -1
    }
  }
}
```

**`flush_interval -1` is mandatory** — without it, Caddy buffers SSE
responses and live updates stop working. This is the #1 production
deployment mistake.

### Production YjsServer

Point YjsServer at the Caddy server (not the raw DS server) if Caddy handles
TLS:

```typescript
const yjsServer = new YjsServer({
  port: 4438,
  dsServerUrl: "https://localhost:443",
  compactionThreshold: 1024 * 1024,
})
```

## Managed with Electric Cloud

Skip infrastructure setup entirely. Provision a Yjs service via the
Electric Cloud CLI:

```bash
# Install and authenticate
npx @electric-sql/cli auth login

# Create a Yjs service
npx @electric-sql/cli services create yjs --json

# Get the service URL and secret
npx @electric-sql/cli services get-secret <service-id> --json
```

Then point YjsProvider at the cloud URL:

```typescript
const provider = new YjsProvider({
  doc,
  baseUrl: "https://api.electric-sql.cloud/v1/yjs/<service-id>",
  docId: "my-doc",
  headers: {
    Authorization: `Bearer <secret>`,
  },
})
```

### Server-side proxy (required for browser apps)

Do NOT expose the Electric Cloud secret to browser clients. Use a
server-side proxy route that injects the Authorization header:

```typescript
// Server route: /api/yjs/*
app.all("/api/yjs/*", async (req, res) => {
  const targetUrl = `https://api.electric-sql.cloud/v1/yjs/<service-id>${req.path.replace("/api/yjs", "")}`
  const response = await fetch(targetUrl, {
    method: req.method,
    headers: {
      ...req.headers,
      Authorization: `Bearer ${process.env.YJS_SECRET}`,
    },
    body: req.method !== "GET" ? req.body : undefined,
    duplex: "half",
  })

  // Block-list headers that break when proxied
  const skipHeaders = new Set([
    "content-encoding",
    "content-length",
    "transfer-encoding",
    "connection",
  ])

  for (const [key, value] of response.headers) {
    if (!skipHeaders.has(key.toLowerCase())) {
      res.setHeader(key, value)
    }
  }

  res.status(response.status)
  response.body.pipe(res)
})
```

Key proxy rules:

- Use a **block-list** for response headers — Yjs protocol uses custom
  headers like `stream-next-offset` that an allow-list would miss
- Block `content-encoding` and `content-length` — Node's `fetch`
  auto-decompresses gzip but leaves the headers, causing
  `ERR_CONTENT_DECODING_FAILED`
- Use `duplex: "half"` when forwarding request bodies

Then point the provider at your proxy:

```typescript
const provider = new YjsProvider({
  doc,
  baseUrl: "/api/yjs", // Must be absolute — use window.location.origin + path
  docId: "my-doc",
})
```

## Common Mistakes

### CRITICAL Missing `flush_interval -1` in Caddy config

Wrong:

```
route /v1/yjs/* {
  reverse_proxy localhost:4438
}
```

Correct:

```
route /v1/yjs/* {
  reverse_proxy localhost:4438 {
    flush_interval -1
  }
}
```

Without this, Caddy buffers SSE responses. Live updates appear to hang —
clients connect but never receive data.

Source: examples/yjs-demo/Caddyfile

### HIGH Exposing Electric Cloud secret to browser clients

Wrong:

```typescript
new YjsProvider({
  doc,
  baseUrl: "https://api.electric-sql.cloud/v1/yjs/<service-id>",
  headers: { Authorization: `Bearer ${cloudSecret}` }, // Leaked!
})
```

Correct: Use a server-side proxy that injects the secret. See the proxy
section above.

### MEDIUM Not configuring compaction threshold

Default is 1MB. For documents with frequent small edits (collaborative text),
this is reasonable. For documents with large binary content (images, files),
increase it to avoid excessive compaction I/O.

## See also

- [yjs-getting-started](../yjs-getting-started/SKILL.md) — Dev server setup
- [yjs-sync](../yjs-sync/SKILL.md) — Provider configuration and events
- [server-deployment](../../../client/skills/server-deployment/SKILL.md) — DS server Caddy config
- [go-to-production](../../../client/skills/go-to-production/SKILL.md) — HTTPS, TTL, CDN checklist

````

- [ ] **Step 2: Verify the file exists and is well-formed**

Run: `head -5 packages/y-durable-streams/skills/yjs-server/SKILL.md`
Expected: YAML frontmatter starting with `---`

- [ ] **Step 3: Commit**

```bash
git add packages/y-durable-streams/skills/yjs-server/SKILL.md
git commit -m "feat(y-durable-streams): add yjs-server skill

Covers YjsServer options, compaction, Caddy reverse proxy with
flush_interval -1, and Electric Cloud managed deployment with
server-side proxy pattern."
````

---

### Task 4: Refocus `yjs-sync` skill

**Files:**

- Modify: `packages/y-durable-streams/skills/yjs-sync/SKILL.md`

Remove setup content (now in yjs-getting-started), fix `setLocalState` advice,
demote `connect: false` pattern, add `requires:` field, add connection state
machine, add tension section.

- [ ] **Step 1: Read the current file**

Run: `cat packages/y-durable-streams/skills/yjs-sync/SKILL.md`

- [ ] **Step 2: Rewrite the skill file**

Replace the entire file with this refocused version:

````markdown
---
name: yjs-sync
description: >
  YjsProvider deep-dive for @durable-streams/y-durable-streams. Provider
  options, connection lifecycle (connect, disconnect, destroy), synced/status/error
  events, connection state machine, dynamic auth headers, liveMode (sse vs
  long-poll), error recovery behavior. Load when configuring provider behavior
  beyond basic setup.
type: composition
library: durable-streams
library_version: "0.2.3"
requires:
  - yjs-getting-started
sources:
  - "durable-streams/durable-streams:packages/y-durable-streams/src/yjs-provider.ts"
  - "durable-streams/durable-streams:packages/y-durable-streams/src/index.ts"
  - "durable-streams/durable-streams:packages/y-durable-streams/YJS-PROTOCOL.md"
---

This skill builds on durable-streams/yjs-getting-started. Read it first for
install and basic setup.

# Durable Streams — Yjs Sync

YjsProvider configuration, lifecycle, and error handling beyond the basics.

## Provider options

```typescript
interface YjsProviderOptions {
  doc: Y.Doc
  baseUrl: string // e.g. "http://host:port/v1/yjs/{service}"
  docId: string // e.g. "my-doc" or "project/chapter-1"
  awareness?: Awareness // optional presence
  headers?: HeadersRecord // static or () => string | Promise<string>
  liveMode?: "sse" | "long-poll" // default "sse"
  connect?: boolean // default true
}

class YjsProvider {
  readonly doc: Y.Doc
  readonly awareness?: Awareness
  readonly synced: boolean
  readonly connected: boolean
  readonly connecting: boolean

  connect(): Promise<void>
  disconnect(): Promise<void>
  destroy(): void

  on(event: "synced", handler: (synced: boolean) => void): void
  on(event: "status", handler: (status: YjsProviderStatus) => void): void
  on(event: "error", handler: (error: Error) => void): void
}
```
````

There is no `contentType` option — the provider always uses
`application/octet-stream` (lib0 VarUint8Array framing).

## Connection state machine

```
disconnected → connecting → connected → disconnected
                   ↓
              disconnected (on error)
```

Connection steps:

1. Ensure document exists (PUT)
2. Discover snapshot offset
3. Create idempotent producer for writes
4. Start updates stream (SSE or long-poll)
5. Start awareness stream (if configured)

The `synced` flag is set to `true` when the server reports `upToDate` —
meaning all existing data has been delivered. It resets to `false` when
local updates are sent, and back to `true` when those updates echo back.

## Core Patterns

### Dynamic auth headers

```typescript
const provider = new YjsProvider({
  doc,
  baseUrl,
  docId,
  headers: {
    Authorization: () => `Bearer ${getAccessToken()}`,
  },
})
```

Header functions are called per-request. Token refresh works without
reconnecting.

### Long-poll instead of SSE

```typescript
const provider = new YjsProvider({
  doc,
  baseUrl,
  docId,
  liveMode: "long-poll", // default is "sse"
})
```

Switch to long-poll only if your infrastructure buffers or drops SSE streams.

### Deferred connection

```typescript
const provider = new YjsProvider({
  doc,
  baseUrl,
  docId,
  connect: false,
})

// Configure before connecting
provider.on("synced", handleSync)
provider.on("error", handleError)
await provider.connect()
```

Only use `connect: false` when you need to configure the provider before
any network activity. With the `useState(() => ...)` React pattern from
yjs-editors, this is unnecessary — the provider is constructed with all
configuration upfront.

## Error recovery

The provider auto-reconnects on transient errors:

- Network errors → retry with 1s delay
- 5xx server errors → retry with backoff
- Snapshot 404 → rediscover snapshot offset

Errors that do NOT trigger reconnect:

- 401/403 auth errors → emits `error` event, stays disconnected
- Provider was explicitly disconnected → no reconnect

## Common Mistakes

### HIGH Using `disconnect()` instead of `destroy()` on unmount

Wrong:

```typescript
return () => provider.disconnect() // Leaks doc/awareness listeners
```

Correct:

```typescript
return () => provider.destroy()
```

`disconnect()` tears down the network connection but leaves `doc.on("update")`
and `awareness.on("update")` listeners attached. `destroy()` calls
`disconnect()` then removes all listeners.

Source: packages/y-durable-streams/src/yjs-provider.ts disconnect() and destroy()

### MEDIUM Listening for events that don't exist

The only events are `synced`, `status`, and `error`. There is no `snapshot`,
`connected`, or `disconnected` event. Use the `status` event for connection
state changes.

Source: packages/y-durable-streams/src/yjs-provider.ts YjsProviderEvents

### HIGH Tension: raw durable streams vs YjsProvider

Use YjsProvider when you need CRDT conflict resolution (collaborative editing,
shared state). Use raw `stream()` from `@durable-streams/client` when you
have append-only data (logs, events, chat messages) where ordering is
sufficient and CRDT overhead isn't needed.

## See also

- [yjs-getting-started](../yjs-getting-started/SKILL.md) — Install and setup
- [yjs-editors](../yjs-editors/SKILL.md) — TipTap and CodeMirror integration
- [yjs-server](../yjs-server/SKILL.md) — Deployment and infrastructure
- reading-streams — Raw stream reading (non-CRDT)
- YJS-PROTOCOL.md — Wire protocol specification

````

- [ ] **Step 3: Verify the changes**

Run: `head -10 packages/y-durable-streams/skills/yjs-sync/SKILL.md`
Expected: Updated frontmatter with `requires:` field

- [ ] **Step 4: Commit**

```bash
git add packages/y-durable-streams/skills/yjs-sync/SKILL.md
git commit -m "refactor(y-durable-streams): refocus yjs-sync skill

Remove setup content (moved to yjs-getting-started), add requires field,
fix setLocalState advice, demote connect:false pattern, add connection
state machine and error recovery docs, add tension section."
````

---

### Task 5: Update docsite `docs/yjs.md`

**Files:**

- Modify: `docs/yjs.md`

Add editor integrations section (brief — skills have the depth) and Electric Cloud deployment option.

- [ ] **Step 1: Read the current file**

Run: `cat docs/yjs.md`

- [ ] **Step 2: Add editor integrations section after "Best practices"**

Insert the following before the "Learn more" section (before line 212):

````markdown
## Editor integrations

### TipTap v3

```bash
npm install @tiptap/react @tiptap/starter-kit \
  @tiptap/extension-collaboration @tiptap/extension-collaboration-caret
```
````

> **Important:** Use `@tiptap/extension-collaboration-caret`, not
> `@tiptap/extension-collaboration-cursor`. The `-cursor` package is a
> broken v3 stub.

```typescript
import { useEditor, EditorContent } from "@tiptap/react"
import StarterKit from "@tiptap/starter-kit"
import Collaboration from "@tiptap/extension-collaboration"
import CollaborationCaret from "@tiptap/extension-collaboration-caret"

const editor = useEditor({
  extensions: [
    StarterKit.configure({ undoRedo: false }),
    Collaboration.configure({ document: ydoc }),
    CollaborationCaret.configure({ provider, user: { name, color } }),
  ],
})
```

### CodeMirror 6

```bash
npm install codemirror @codemirror/state @codemirror/view y-codemirror.next
```

```typescript
import { yCollab } from "y-codemirror.next"

const ytext = ydoc.getText("content")
const state = EditorState.create({
  doc: ytext.toString(),
  extensions: [basicSetup, yCollab(ytext, awareness)],
})
```

See the [Yjs demo](https://github.com/durable-streams/durable-streams/tree/main/examples/yjs-demo) for a complete CodeMirror example.

````

- [ ] **Step 3: Add Electric Cloud deployment option**

Insert a "Deployment" section after "How it works" (after the compaction and URL structure subsections), before "Best practices":

```markdown
## Deployment

### Development

Use `DurableStreamTestServer` + `YjsServer` as shown in the quick start. See the [deployment guide](/deployment) for details.

### Production (self-hosted)

Run the Caddy binary with the durable_streams plugin for storage, and reverse-proxy to YjsServer:

````

:443 {
route /v1/stream/_ {
durable_streams {
data_dir ./data
}
}
route /v1/yjs/_ {
reverse_proxy localhost:4438 {
flush_interval -1
}
}
}

````

`flush_interval -1` is required — without it, Caddy buffers SSE responses and live updates stop working.

### Managed (Electric Cloud)

<IntentLink intent="create" serviceType="yjs" />

Deploy on Electric Cloud for managed hosting with no infrastructure to maintain.

```bash
npx @electric-sql/cli services create yjs --json
npx @electric-sql/cli services get-secret <service-id> --json
````

Point `baseUrl` at the cloud URL and pass the secret as an `Authorization` header. For browser apps, use a server-side proxy to avoid exposing the secret.

````

- [ ] **Step 4: Verify the updated file renders correctly**

Run: `grep -n "## " docs/yjs.md`
Expected: Sections in order: Installation, Quick start, Provider options, Events, Lifecycle, Authentication, Awareness, How it works, Deployment, Best practices, Editor integrations, Learn more

- [ ] **Step 5: Commit**

```bash
git add docs/yjs.md
git commit -m "docs(yjs): add editor integrations and deployment sections

Add TipTap v3 and CodeMirror 6 quick examples with -caret vs -cursor
warning. Add deployment section with self-hosted Caddy and Electric
Cloud options."
````

---

## Self-review

**Spec coverage:**

- ✅ 3 new skills (yjs-getting-started, yjs-editors, yjs-server)
- ✅ Refocused yjs-sync with corrections
- ✅ TipTap canonical pattern with all 5 documented bugs
- ✅ CodeMirror integration
- ✅ Electric Cloud as managed alternative (not default)
- ✅ Server-side proxy for Electric Cloud
- ✅ Docsite updates (brief, not bloated)
- ✅ Context bloat: no redundancy between skills, cross-references via "See also"

**Placeholder scan:** No TBD/TODO found. All code blocks are complete.

**Type consistency:** `YjsProvider`, `YjsServer`, `Awareness` used consistently. `baseUrl`/`docId` naming matches source code.

**Ordering note:** Tasks 1-3 are independent (new files). Task 4 modifies existing file. Task 5 modifies docsite. No blocking dependencies between tasks — can be parallelized.
