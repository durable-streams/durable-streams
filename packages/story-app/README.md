# 📖 Tell Me a Story!

A demonstration of **durable streaming** for AI-generated content, built with TanStack Start, TanStack AI, and Durable Streams.

The app itself is a fun, child-friendly story generator — kids enter a prompt and the app generates and narrates a unique story just for them. But under the hood, it's showcasing how durable streams solve real problems with streaming AI content.

## What This Demonstrates

This app showcases the power of **durable streams** for handling AI-generated streaming content. When OpenAI generates a story, both the text transcript and audio narration are streamed in real-time. Instead of sending this ephemeral stream directly to the browser, we capture it in a **durable stream** that persists the data.

### Why Durability Matters

Traditional streaming is ephemeral—if the connection drops, the data is lost. With durable streams:

- **🔄 Refresh Resilience** - Refresh the page mid-story and playback resumes from exactly where you left off. The stream retains all data, so the client simply reconnects and continues.

- **📡 Network Resilience** - If the network drops during generation or playback, no data is lost. When connectivity returns, the stream picks up seamlessly.

- **🔗 Shareable During Generation** - Share a story URL while it's still being generated. Recipients can start listening immediately, even catching up on content that was generated before they joined.

- **⏸️ Pause & Resume** - Close the tab, come back hours later, and continue from where you stopped. The complete stream is still available.

### How It Works

1. **User submits a prompt** → Server creates a new durable stream
2. **TanStack AI generates the story** → Text and audio are streamed back via the OpenAI adapter
3. **Frames are appended to the stream** → Each chunk (text or audio) is encoded as a binary frame and durably persisted
4. **Client subscribes to the stream** → Audio plays in real-time as frames arrive
5. **On refresh/reconnect** → Client reloads the stream from the beginning, rebuilds the audio buffer, seeks to the saved position, and resumes playback

The server returns the stream ID immediately and continues processing the AI response in the background. This means the HTTP request completes quickly while generation continues asynchronously.

## Features

- **AI-Generated Stories** - Uses TanStack AI with OpenAI's GPT-4o Audio to create unique narrated stories
- **Synchronized Text & Audio** - Text appears in sync with the spoken narration
- **7-Day Persistence** - Stories remain available for a week
- **Child-Friendly UI** - Colorful, playful design with intuitive controls

## Technology Stack

- **[TanStack AI](https://tanstack.com/ai)** - Type-safe AI SDK with OpenAI adapter for audio-enabled chat completions
- **[TanStack Start](https://tanstack.com/start)** - Full-stack React framework with server functions
- **Durable Streams** - Persistent streaming infrastructure for resilient content delivery
- **Web Audio API** - Real-time PCM16 audio playback

## Setup

### Prerequisites

- Node.js 18+
- pnpm
- OpenAI API key with access to `gpt-4o-audio-preview`

### Environment Variables

Copy the example environment file:

```bash
cp .env.example .env
```

Edit `.env` with your configuration:

```
OPENAI_API_KEY=sk-your-openai-api-key
DURABLE_STREAM_URL=http://localhost:4437
```

### Running

Start both the durable streams server and the story app:

```bash
cd packages/story-app
pnpm dev
```

This will start:

- **Durable Streams Server** on http://localhost:4437
- **Story App** on http://localhost:3001

Open http://localhost:3001 in your browser.

## Try the Durability Demo

1. **Start a story** - Enter a prompt and click "Create My Story!"
2. **While it's playing, refresh the page** - Notice how playback resumes from exactly where you were
3. **Copy the URL and open in another tab** - Both tabs receive the same stream
4. **Start a new story and share the URL immediately** - The recipient can start listening even while generation continues

## Architecture

### Binary Frame Protocol

Stories are stored as binary frames in the durable stream:

| Frame Type | Code | Description                                |
| ---------- | ---- | ------------------------------------------ |
| Metadata   | 0x00 | Initial prompt JSON                        |
| Text       | 0x01 | Transcript chunk (includes `isTitle` flag) |
| Audio      | 0x02 | PCM16 audio data (24kHz mono)              |
| End        | 0x03 | End of stream marker                       |
| Error      | 0x04 | Error message                              |

Each frame has a 5-byte header: 1 byte type + 4 bytes length (big-endian).

### Key Components

- `src/server/functions.ts` - Server function that creates streams and uses TanStack AI
- `src/lib/frame-parser.ts` - Binary frame encoding/decoding
- `src/lib/audio-player.ts` - Web Audio API PCM16 streaming player
- `src/lib/storage.ts` - Session storage for playback position
- `src/routes/story.$streamId.tsx` - Story playback page with resume logic

### TanStack AI Audio Streaming

The server function uses TanStack AI with the OpenAI adapter for audio output:

```typescript
import { chat } from "@tanstack/ai"
import { createOpenAI } from "@tanstack/ai-openai"

const adapter = createOpenAI(OPENAI_API_KEY)

const stream = chat({
  adapter,
  model: "gpt-4o-audio-preview",
  messages: [{ role: "user", content: prompt }],
  systemPrompts: [SYSTEM_PROMPT],
  providerOptions: {
    modalities: ["text", "audio"],
    audio: { voice: "alloy", format: "pcm16" },
  },
})

for await (const chunk of stream) {
  if (chunk.type === "audio") {
    // Handle audio data (base64-encoded PCM16)
  }
  if (chunk.type === "content") {
    // Handle transcript text
  }
}
```

The OpenAI adapter automatically detects when `modalities` includes `"audio"` and uses the Chat Completions API instead of the Responses API, enabling streaming audio output.

## License

MIT
