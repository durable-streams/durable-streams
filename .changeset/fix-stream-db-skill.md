---
"@durable-streams/state": patch
---

docs(stream-db): show list query pattern for useLiveQuery

Added list query example with `{ data }` destructuring and default empty array alongside the existing findOne pattern. Prevents agents from writing `allSessions.map(...)` instead of `const { data: allSessions = [] } = useLiveQuery(...)`.
