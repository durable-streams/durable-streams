---
"@durable-streams/state": patch
---

Add per-collection field parsers for transforming raw JSON values during event dispatch. This follows Electric's parser pattern but operates per-collection and per-field. Parsers are defined in the collection definition and applied to incoming stream data before writing to TanStack DB collections.

Example usage:
```typescript
const stateSchema = createStateSchema({
  events: {
    schema: eventSchema,
    type: 'event',
    primaryKey: 'id',
    parser: {
      createdAt: (v: unknown) => new Date(v as string),
      updatedAt: (v: unknown) => new Date(v as string),
    },
  },
})
```
