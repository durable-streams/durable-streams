# Examples Directory Guidelines

## TanStack DB + Solid.js Integration

**CRITICAL: Always use `useLiveQuery` from `@tanstack/solid-db`**

When working with TanStack DB collections in Solid.js:

1. **Always use `useLiveQuery`** - Never manually subscribe to collections
2. **ALWAYS push filtering/sorting into query builder** - Dramatically faster with differential dataflow
3. **Avoid JavaScript filtering** - Use `.where()`, `.orderBy()`, `.groupBy()` in queries instead
4. **Remember**: `query.data` is a store array (no `()`), but `query.isLoading()` IS an accessor (needs `()`)

### Correct Pattern

```typescript
import { useLiveQuery } from '@tanstack/solid-db';
import { eq, and } from '@tanstack/db';

function MyComponent() {
  const db = useMyDB();

  // Push filtering and sorting into the query builder
  const eventsQuery = useLiveQuery((q) =>
    q.from({ events: db.collections.events })
      .where(({ events }) => and(
        eq(events.language, 'en'),
        eq(events.active, true)
      ))
      .orderBy(({ events }) => events.timestamp, 'desc')
      .limit(100)
  );

  // Access data directly - it's already reactive
  return <For each={eventsQuery.data}>{/* ... */}</For>;
}
```

### Incorrect Patterns to Avoid

❌ **DON'T manually subscribe:**

```typescript
// Wrong - manual subscription management
const [events, setEvents] = createSignal([])
onMount(() => {
  const subscription = db.collections.events.subscribeChanges(() => {
    setEvents(Array.from(db.collections.events.values()))
  })
})
```

❌ **DON'T do filtering in JavaScript:**

```typescript
// Wrong - filters in JavaScript instead of using query builder
const query = useLiveQuery(() => db.collections.events)
const filtered = createMemo(() => query.data.filter((e) => e.language === "en"))
```

✅ **DO push filtering into query builder:**

```typescript
// Correct - leverages differential dataflow
const query = useLiveQuery((q) =>
  q.from({ events: db.collections.events })
    .where(({ events }) => eq(events.language, 'en'))
);
<For each={query.data}>
```

✅ **DO call status accessors:**

```typescript
// Correct - status methods ARE accessor functions
if (query.isLoading()) {
  return <Spinner />;
}
```

## StreamDB Collections

StreamDB collections are TanStack DB collections internally, so `useLiveQuery` works seamlessly:

```typescript
const db = createStreamDB({
  streamOptions: { url: streamUrl },
  state: stateSchema,
})

// db.collections.* are TanStack DB Collections
const query = useLiveQuery(() => db.collections.events)
```

## Query Building

Use TanStack DB's query builder for complex queries:

```typescript
const query = useLiveQuery((q) =>
  q
    .from({ events: db.collections.events })
    .where(({ events }) => eq(events.language, "en"))
    .select(({ events }) => ({ id: events.id, title: events.title }))
)
```

## Status Handling

Always handle loading/error states:

```typescript
<Switch>
  <Match when={query.isLoading()}>Loading...</Match>
  <Match when={query.isError()}>Error</Match>
  <Match when={query.isReady()}>
    <For each={query.data()}>{/* content */}</For>
  </Match>
</Switch>
```

## Reference

See skill: `~/.claude/skills/tanstack-solid-live-query.md`
