# AI Session UI

A multi-agent chat prototype built on Durable Streams. Multiple AI agents subscribe to a shared stream and respond to user messages based on their capabilities.

## Architecture

```
┌─────────────────┐     ┌─────────────────────────────┐
│   Browser UI    │────▶│   Durable Streams Server    │
│  (React + Vite) │◀────│        (port 4000)          │
└─────────────────┘     └─────────────────────────────┘
                                     │
                        ┌────────────┴────────────┐
                        ▼                         ▼
               ┌─────────────────┐       ┌─────────────────┐
               │  File Explorer  │       │  Web Explorer   │
               │     Agent       │       │     Agent       │
               │  (filesystem)   │       │     (api)       │
               └─────────────────┘       └─────────────────┘
```

The stream is the event bus. Agents are listeners that:
1. Watch for new user messages via TanStack DB live queries
2. Check relevance using a fast Haiku classifier
3. Process with Sonnet (which can decline via `stop` tool)
4. Write responses back to the stream

## Running

```bash
# Terminal 1: Start the server
npx tsx server.ts

# Terminal 2: Start the UI
pnpm dev

# Terminal 3: Start filesystem agent
ANTHROPIC_API_KEY=your-key npx tsx agent-runner.ts filesystem http://localhost:4000/sessions/your-session-id

# Terminal 4: Start web explorer agent
ANTHROPIC_API_KEY=your-key npx tsx agent-runner.ts api http://localhost:4000/sessions/your-session-id
```

## Agent Routing

Two-stage routing prevents both false negatives and false positives:

1. **Haiku (permissive gate)**: Quick check biased towards "yes" - only rejects clearly irrelevant messages
2. **Sonnet (final authority)**: Can call `stop` tool to decline if message isn't actually relevant

This pattern ensures:
- Ambiguous messages (like "continue") get routed correctly via conversation context
- Agents don't respond to messages outside their capabilities
- The expensive model has final say

## Key Design Decisions

### Stream as Source of Truth
All state flows through the durable stream. Messages, deltas, tool calls, and results are all events. The UI and agents are just projections of stream state via TanStack DB.

### Insert-Only Deltas
Messages are built from append-only deltas with `(messageId, partIndex, seq)` ordering. This enables:
- Streaming responses
- Tool call/result interleaving
- Efficient incremental updates

### Multi-Agent Coordination
Agents independently subscribe and respond. No central orchestrator. Relevance is determined locally by each agent.

---

## Future Ideas (from OpenAI Codex Agent Loop)

Insights from [Unrolling the Codex Agent Loop](https://openai.com/index/unrolling-the-codex-agent-loop/) that could improve this prototype:

### 1. Prompt Caching via Prefix Consistency
> "The old prompt is an exact prefix of the new prompt... this enables us to take advantage of prompt caching"

Structure conversation history to maximize cache hits - static content first (system prompt, tool definitions), dynamic content last.

### 2. Encrypted Reasoning Compaction
> "A special type=compaction item with an opaque encrypted_content item that preserves the model's latent understanding"

For long sessions, instead of summarizing, preserve the model's internal state. Could implement checkpoint deltas that agents can resume from.

### 3. Layered Instructions (AGENTS.md pattern)
> "Look in each folder from the Git/project root... add contents of AGENTS.override.md, AGENTS.md"

Hierarchical config: global → repo → subfolder. Each level can override or extend. Agents could have their own instruction files.

### 4. Permissions as Developer Messages
> "A message with role=developer that describes the sandbox... instructions for when to ask the user for permissions"

Rather than hard-coded approval modes, teach the model *when* to ask. The model decides based on context, not the harness.

### 5. Configuration Changes as Appended Messages
> "We handle configuration changes mid-conversation by appending a new message... rather than modifying an earlier message"

Never mutate history - only append. Preserves cache and audit trail. If an agent's tools or permissions change mid-session, write a config delta.

### 6. Checkpoint Deltas
When context gets large, write a "checkpoint" delta with compressed conversation summary. Agents can start from checkpoint rather than replaying full history.

### 7. Shell-First Tool Design
Codex uses one primary `shell` tool that can do everything. Consider whether unified tools vs. specialized tools (our current approach) is better for different use cases.
