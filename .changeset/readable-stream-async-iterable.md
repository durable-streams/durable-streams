---
"@durable-streams/client": minor
---

Add soft polyfill for ReadableStream async iteration on Safari/iOS.

Safari/iOS may not implement `ReadableStream.prototype[Symbol.asyncIterator]`, preventing `for await...of` consumption. This change ensures all ReadableStreams returned by the client are async-iterable by defining `[Symbol.asyncIterator]` on stream instances when missing.

**Key features:**
- No global prototype patching - only the returned stream instances are modified
- `instanceof ReadableStream` behavior is preserved (same object, not wrapped)
- Uses `getReader().read()` for spec-consistent iteration
- Properly handles early exit (`break`) with cancellation and lock release

**API changes:**
- `bodyStream()`, `jsonStream()`, and `textStream()` now return `ReadableStream<T> & AsyncIterable<T>`
- New exported type: `ReadableStreamAsyncIterable<T>`

All users can now safely use `for await (const chunk of res.bodyStream())` without requiring a global polyfill.
