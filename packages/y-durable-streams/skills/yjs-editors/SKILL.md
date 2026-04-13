---
name: yjs-editors
description: >
  Integrate Yjs collaborative editing with TipTap v3 and CodeMirror 6 over
  durable streams. Canonical React pattern: doc+awareness in useState,
  provider in useEffect with connect:false (listeners before connect).
  TipTap: Collaboration + CollaborationCaret extensions, -caret not -cursor
  package. CodeMirror: yCollab binding. Covers awareness wiring,
  multi-document navigation with key={docId}, SSR ssr:false requirement.
  Critical anti-patterns that crash agents documented.
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

All editor integrations MUST use this pattern. It matches the working
`examples/yjs-demo/src/components/yjs-provider.tsx` in this repository.

**Key principle:** Doc and awareness are created once via `useState` (stable
references). The provider is created in `useEffect` with `connect: false` so
that event listeners are attached BEFORE the first network request. This
prevents the race condition where `synced` fires between construction and
listener attachment.

```typescript
import { useState, useEffect, useRef } from "react"
import { YjsProvider } from "@durable-streams/y-durable-streams"
import * as Y from "yjs"
import { Awareness } from "y-protocols/awareness"

function CollabEditor({ docId }: { docId: string }) {
  // 1. Doc + awareness: stable, created once via useState lazy init.
  //    Use setLocalState (not setLocalStateField) because a new
  //    Awareness starts with null state.
  const [{ doc, awareness }] = useState(() => {
    const d = new Y.Doc()
    const aw = new Awareness(d)
    aw.setLocalState({
      user: {
        name: localStorage.getItem("userName") || "Anonymous",
        color: localStorage.getItem("userColor") || "#d0bcff",
      },
    })
    return { doc: d, awareness: aw }
  })

  // 2. Provider: created in useEffect with connect:false.
  //    Listeners are attached BEFORE connect() so events are never missed.
  const [provider, setProvider] = useState<YjsProvider | null>(null)
  const [synced, setSynced] = useState(false)

  useEffect(() => {
    // Re-set awareness if React strict mode cleanup cleared it
    if (awareness.getLocalState() === null) {
      awareness.setLocalState({
        user: {
          name: localStorage.getItem("userName") || "Anonymous",
          color: localStorage.getItem("userColor") || "#d0bcff",
        },
      })
    }

    const p = new YjsProvider({
      doc,
      baseUrl: "https://your-server.com/v1/yjs/my-service",
      docId,
      awareness,
      connect: false, // listeners first, then connect
    })

    // Attach listeners BEFORE connect()
    p.on("synced", (s: boolean) => {
      if (s) setSynced(true)
    })
    p.on("error", (err: Error) => {
      console.error("[YjsProvider] error:", err)
    })

    setProvider(p)
    p.connect()

    return () => {
      p.destroy()
      setProvider(null)
    }
  }, [doc, awareness, docId])

  // 3. Clean up doc + awareness on component unmount
  useEffect(() => {
    return () => {
      awareness.destroy()
      doc.destroy()
    }
  }, [doc, awareness])

  // 4. Editor setup goes here (see TipTap / CodeMirror sections below)
  // ...
}
```

### Why `connect: false` is required

The provider starts its async connection flow immediately in the constructor
when `connect` is `true` (the default). This means:
- `ensureDocument` (PUT), `discoverSnapshot` (GET with 307 handling), and
  `startUpdatesStream` all fire before React's `useEffect` runs
- The `synced` event can fire before any listener is attached
- React strict mode double-renders make this race worse — the first render's
  provider is destroyed, and the event is lost

With `connect: false`, the provider is inert until `p.connect()` is called
explicitly — after all listeners are attached. No race, no missed events.

### Why doc/awareness are in `useState` but provider is in `useEffect`

|                            | Doc + Awareness              | Provider                    |
| -------------------------- | ---------------------------- | --------------------------- |
| Created via                | `useState(() => ...)`        | `useEffect` + `connect:false` |
| Stable across re-renders   | Yes (useState is stable)     | Recreated when docId changes |
| Event listeners            | None needed before creation  | Must be attached before connect |
| Cleanup                    | Separate unmount effect      | Effect cleanup destroys it  |

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

Using the shared lifecycle pattern above, add the editor. Note: provider
starts as `null` and becomes non-null after the `useEffect` runs. Use a
conditional spread for `CollaborationCaret` and `[provider]` as a dep so
the editor recreates when the provider arrives:

```tsx
import { useEditor, EditorContent } from "@tiptap/react"
import StarterKit from "@tiptap/starter-kit"
import Collaboration from "@tiptap/extension-collaboration"
import CollaborationCaret from "@tiptap/extension-collaboration-caret"

// Inside CollabEditor component, after the shared lifecycle code:

const editor = useEditor(
  {
    extensions: [
      StarterKit.configure({ undoRedo: false }),
      Collaboration.configure({ document: doc }),
      ...(provider
        ? [
            CollaborationCaret.configure({
              provider,
              user: {
                name: localStorage.getItem("userName") || "Anonymous",
                color: localStorage.getItem("userColor") || "#d0bcff",
              },
            }),
          ]
        : []),
    ],
    editorProps: {
      attributes: {
        class: "prose max-w-none min-h-[60vh] focus:outline-none",
      },
    },
  },
  [provider], // recreate editor when provider becomes available
)

if (!synced) return <p>Connecting...</p>
return <EditorContent editor={editor} />
```

Key points:
- `undoRedo: false` — Yjs has its own undo manager; StarterKit's conflicts
- `CollaborationCaret` uses a conditional spread because `provider` is
  `null` on first render (before the effect). The `[provider]` dep array
  on `useEditor` recreates the editor when the provider arrives.
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

  const ytext = doc.getText("content")
  const state = EditorState.create({
    doc: ytext.toString(),
    extensions: [basicSetup, EditorView.lineWrapping, yCollab(ytext, awareness)],
  })

  const view = new EditorView({ state, parent: editorRef.current })
  return () => view.destroy()
}, [synced, doc, awareness])

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

### CRITICAL Auto-connecting provider without listeners

Wrong:

```tsx
// Provider auto-connects in constructor — synced event fires before
// useEffect attaches the listener → stuck on "Connecting..." forever
const [provider] = useState(
  () => new YjsProvider({ doc, baseUrl, docId, awareness })
)

useEffect(() => {
  provider.on("synced", (s) => { if (s) setSynced(true) })
  // TOO LATE — synced already fired during construction
}, [provider])
```

Correct: Use the `useEffect` + `connect: false` pattern from the lifecycle
section above. Listeners are attached before `connect()` is called.

This is the #1 cause of "stuck Connecting" in agent-built apps. The provider
connects, syncs, emits `synced: true`, but no listener is attached yet.
React's `useEffect` runs after the render cycle, by which time the async
connection has already completed.

Source: Documented in 5+ agent sessions; matches examples/yjs-demo pattern

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
