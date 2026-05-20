---
"@durable-streams/aisdk-transport": patch
"@durable-streams/tanstack-ai-transport": patch
---

Engage client-side batching in AI SDK and TanStack AI transport response
writers. The transports previously awaited every `stream.append(...)` call
inside the source loop, which kept the client's internal batch queue idle
and turned every chunk into its own POST. The writers now fire-and-track
appends and drain pending writes before closing, restoring batching for
high-frequency token streams. Documents the batching engagement contract
on `DurableStream.append()` so library users don't reintroduce the pattern.
