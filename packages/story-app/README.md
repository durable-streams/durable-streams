# 📖 Tell Me a Story!

A magical story generator for children, built with TanStack Start and Durable Streams.

## Features

- **AI-Generated Stories** - Uses OpenAI's GPT-4o with audio to create unique stories based on prompts
- **Real-time Audio Playback** - Stories are narrated as they're generated using PCM16 streaming audio
- **Durable Streams** - Stories are persisted for 7 days and can be shared via URL
- **Auto-Resume** - Refresh the page and pick up where you left off
- **Child-Friendly UI** - Colorful, playful design with large touch targets

## How It Works

1. User enters a story prompt (e.g., "A brave little mouse who wants to become a knight")
2. Server creates a durable stream and starts generating the story with OpenAI
3. Text and audio are streamed back in binary frames and appended to the durable stream
4. Client subscribes to the stream and plays audio in real-time
5. The story URL can be shared with anyone

## Setup

### Prerequisites

- Node.js 18+
- pnpm
- OpenAI API key with access to `gpt-4o-audio-preview`
- Durable Streams server running

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

Open http://localhost:3001 in your browser to use the app.

#### Running Separately

If you prefer to run the servers in separate terminals:

```bash
# Terminal 1: Durable streams server
pnpm dev:stream

# Terminal 2: Story app
pnpm dev:app
```

## Architecture

### Binary Frame Protocol

Stories are stored as binary frames in the durable stream:

| Frame Type | Code | Description |
|------------|------|-------------|
| Metadata   | 0x00 | Initial prompt JSON |
| Text       | 0x01 | Transcript chunk (includes `isTitle` flag) |
| Audio      | 0x02 | PCM16 audio data (24kHz mono) |
| End        | 0x03 | End of stream marker |
| Error      | 0x04 | Error message |

Each frame has a 5-byte header: 1 byte type + 4 bytes length (big-endian).

### Key Components

- `src/server/functions.ts` - Server function that creates streams and calls OpenAI
- `src/lib/frame-parser.ts` - Binary frame encoding/decoding
- `src/lib/audio-player.ts` - Web Audio API PCM16 player
- `src/lib/storage.ts` - Session storage for playback progress
- `src/routes/story.$streamId.tsx` - Story playback page

## License

MIT
