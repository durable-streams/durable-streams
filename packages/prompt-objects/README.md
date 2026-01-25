# @durable-streams/prompt-objects

> Taking message-passing seriously: Self-modifying AI objects that communicate in natural language

This package implements the ideas from Scott Werner's "[What If We Took Message-Passing Seriously?](https://worksonmymachine.substack.com/p/what-if-we-took-message-passing-seriously)" - applying Alan Kay's vision of objects as self-contained computers to AI agents.

## Key Concepts

### Prompt Objects (not "Agents")

> "What if an 'agent' is more than just thing that does tasks, but a self-contained computing environment that can receive messages and interpret them however it wants?"

A **Prompt Object** is:

- A self-contained computing environment with an identity (system prompt)
- An inbox (durable stream) for receiving messages
- Capabilities it can use (and modify at runtime)
- State it can read and write
- The ability to create other objects

### Semantic Late Binding

Messages between objects are **natural language**, interpreted by the receiver at runtime. The meaning of a message isn't fixed by the sender - it's determined by how the receiver chooses to interpret it.

```
Object A → "Please analyze this data" → Object B
                                          ↓
                              Object B decides what "analyze" means
```

### Self-Modification

Objects can discover and add capabilities to themselves. They start minimal and bootstrap into competence:

```
1. Object receives: "Read the README file"
2. Object realizes: "I don't have file reading capability"
3. Object queries: "What primitives are available?"
4. Object discovers: read_file, write_file, list_directory...
5. Object adds: read_file capability to itself
6. Object executes: reads the file
```

This is **normal and expected behavior**, not an edge case.

## Installation

```bash
npm install @durable-streams/prompt-objects @anthropic-ai/sdk
```

## Quick Start

```typescript
import {
  createRuntime,
  AnthropicProvider,
} from "@durable-streams/prompt-objects"

// Create the runtime
const runtime = createRuntime({
  streamsBaseUrl: "http://localhost:8080/streams",
  llmProvider: new AnthropicProvider({
    apiKey: process.env.ANTHROPIC_API_KEY,
  }),
})

// Create an object
const assistant = await runtime.createObject({
  name: "assistant",
  systemPrompt: `You are a helpful assistant. When you need capabilities
you don't have, query the available primitives and add them to yourself.`,
})

// Send it a message
await runtime.sendExternal(
  assistant.id,
  "What files are in the current directory?"
)

// The object will:
// 1. Realize it needs list_directory capability
// 2. Query available primitives
// 3. Add list_directory to itself
// 4. Execute the listing
// 5. Respond with the results
```

## Core Capabilities

Every prompt object starts with these core capabilities:

| Capability             | Description                            |
| ---------------------- | -------------------------------------- |
| `think`                | Internal reasoning (not sent anywhere) |
| `query_primitives`     | Discover available capabilities        |
| `add_capability`       | Add a capability to self               |
| `remove_capability`    | Remove a capability from self          |
| `update_system_prompt` | Modify own identity                    |
| `create_object`        | Spawn new objects                      |
| `send_message`         | Communicate with other objects         |
| `list_objects`         | See all objects in runtime             |
| `get_state`            | Read persistent state                  |
| `set_state`            | Write persistent state                 |

## Available Primitives

The runtime provides a standard library of primitives that objects can add:

| Primitive          | Description               |
| ------------------ | ------------------------- |
| `read_file`        | Read file contents        |
| `write_file`       | Write to files            |
| `list_directory`   | List directory contents   |
| `http_fetch`       | Make HTTP requests        |
| `execute_command`  | Run shell commands        |
| `parse_json`       | Parse JSON strings        |
| `calculate`        | Evaluate math expressions |
| `delay`            | Wait for milliseconds     |
| `get_current_time` | Get current date/time     |
| `random`           | Generate random numbers   |

You can also add custom primitives:

```typescript
const runtime = createRuntime({
  // ...
  primitives: [
    {
      name: "send_email",
      description: "Send an email to someone",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string" },
          subject: { type: "string" },
          body: { type: "string" },
        },
        required: ["to", "subject", "body"],
      },
      execute: async (params) => {
        // Your email sending logic
        return { success: true }
      },
    },
  ],
})
```

## Multi-Object Systems

Objects can create other objects and communicate with them:

```typescript
const orchestrator = await runtime.createObject({
  name: "orchestrator",
  systemPrompt: `You coordinate work by creating specialized workers.
When given a complex task:
1. Break it into subtasks
2. Create specialized objects for each
3. Send them messages to do the work
4. Collect and synthesize results`,
})

await runtime.sendExternal(
  orchestrator.id,
  "Research the weather in Tokyo and write a haiku about it"
)

// The orchestrator might:
// 1. Create a "researcher" object with HTTP capabilities
// 2. Create a "poet" object specialized in haiku
// 3. Send researcher: "Get Tokyo weather"
// 4. Send poet: "Write haiku about [weather data]"
// 5. Combine the results
```

## Why Durable Streams?

Each object has an **inbox** implemented as a durable stream. This provides:

- **Persistence**: Messages survive restarts
- **Resumability**: Objects can catch up on missed messages
- **Exactly-once semantics**: No duplicate processing
- **Decoupling**: Senders don't need receivers to be online

This makes prompt objects suitable for long-running, distributed systems where reliability matters.

## Philosophy

This implementation takes seriously the idea that:

1. **Objects are computers, not data structures**. They have identity, behavior, and autonomy.

2. **Messages are interpreted, not executed**. The receiver decides what a message means.

3. **Late binding is powerful**. Deferring decisions to runtime enables flexibility.

4. **Self-modification is natural**. Systems that can grow and adapt are more interesting.

5. **Natural language is an interface**. LLMs make semantic message-passing practical.

As Werner writes:

> "We accidentally built the runtime that Smalltalk always wanted."

## Examples

See the `examples/` directory:

- `basic.ts` - Single object bootstrapping capabilities
- `multi-object.ts` - Objects creating and coordinating with each other

## License

MIT
