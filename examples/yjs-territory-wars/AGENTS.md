# Territory Wars - Agent Guidelines

## Project

Multiplayer territory capture game with AI bot agents. 128x128 grid, Yjs CRDTs over Durable Streams, Claude Haiku-powered bots.

## Structure

- `src/components/` — React UI (Lobby, GameRoom, TerritoryGame)
- `src/utils/` — Shared game logic, schemas
- `src/agent/` — Server-side AI bot code (agent-server, ai-player, pathfinder, haiku-client)
- `server.ts` — Node.js entry point for AI agent server

## Running

```sh
pnpm dev          # Game client (browser)
pnpm dev:server   # AI agent server (bots)
```

<!-- intent-skills:start -->

# Skill mappings - when working in these areas, load the linked skill file into context.

skills:

- task: "Working with StreamDB, room registry, or reactive state collections"
  load: "node_modules/@durable-streams/state/skills/stream-db/SKILL.md"
- task: "Defining or modifying state schemas for room registry or scores"
  load: "node_modules/@durable-streams/state/skills/state-schema/SKILL.md"
- task: "Working with Yjs sync, awareness, or the YjsProvider connection"
  load: "node_modules/@durable-streams/y-durable-streams/skills/yjs-sync/SKILL.md"
- task: "Reading or subscribing to durable streams"
  load: "node_modules/@durable-streams/client/skills/reading-streams/SKILL.md"
- task: "Writing or appending data to durable streams"
  load: "node_modules/@durable-streams/client/skills/writing-data/SKILL.md"
- task: "Working with React UI, live queries, or useLiveQuery"
  load: "node_modules/@tanstack/react-db/skills/react-db/SKILL.md"
- task: "Working with TanStack DB collections, queries, or mutations"
  # To load this skill, run: npx @tanstack/intent@latest list | grep db-core
- task: "Working with live queries, subscribeChanges, or derived collections" # To load this skill, run: npx @tanstack/intent@latest list | grep live-queries
<!-- intent-skills:end -->
