# AI chat transport demo

Demonstrates the AI-transport use case for Durable Streams: a (simulated)
model streams answer tokens **through the server**, and the UI renders only
what it reads back from the stream. Because the response is a durable,
offset-addressable resource:

- **Reload mid-stream** and the transcript catches up instantly from the
  saved offset, then keeps tailing live over SSE.
- The interrupted **writer resumes** where it stopped, protected by
  idempotent producer sequencing (`Producer-Id`/`Producer-Epoch`/`Producer-Seq`) —
  a retried token batch can never be double-appended.
- Closing the stream gives every reader a clean **EOF** (`streamClosed`).

## Run it

Everything is client-side; just serve the file and open it:

```bash
npx serve examples/ai-chat
```

By default it talks to the deployed workers.dev instance. To point it at
local dev (`npm run dev` in the repo root):

```js
localStorage.setItem("ds-server", "http://localhost:8787");
```

Click **Generate answer**, reload the page mid-stream, and watch the
transcript resume without losing a token.
