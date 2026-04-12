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

### Why `useState(() => ...)` not `useEffect` + `setState(null)`

|                            | `useEffect` + `useState(null)` | `useState(() => new ...)` |
| -------------------------- | ------------------------------ | ------------------------- |
| Provider on first render   | `null`                         | **non-null**              |
| Editor extensions config   | needs conditional guards       | always gets valid objects  |
| Editor recreations         | twice (without, then with)     | **once**                  |
| Cleanup race               | `setState(null)` = stale render| no intermediate null      |

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
    extensions: [basicSetup, EditorView.lineWrapping, yCollab(ytext, awareness)],
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
  return () => { p.destroy(); setProvider(null) }
}, [ydoc, awareness, docId])

const editor = useEditor({
  extensions: [
    ...(provider
      ? [CollaborationCaret.configure({ provider })]
      : []),
  ],
}, [provider])
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
