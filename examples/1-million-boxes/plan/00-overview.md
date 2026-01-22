# 1 Million Boxes — Implementation Plan

## Overview

This plan breaks down the implementation into **11 phases** with clear dependencies. Each phase has one or more task files with specific deliverables.

## Phases

| Phase | Name                | Description                                     | Dependencies |
| ----- | ------------------- | ----------------------------------------------- | ------------ |
| 01    | Project Setup       | TanStack Start + Cloudflare Workers scaffolding | None         |
| 02    | Core Game Logic     | Edge math, game state, stream parsing           | 01           |
| 03    | Backend Server      | GameWriterDO, team allocation, APIs             | 01, 02       |
| 04    | Frontend Foundation | Layout, routing, CSS, providers                 | 01           |
| 05    | Canvas Rendering    | Main canvas with pan/zoom                       | 02, 04       |
| 06    | UI Components       | Quota meter, team badge, scoreboard             | 04           |
| 07    | Real-time Sync      | SSE connection, live state updates              | 02, 03, 05   |
| 08    | World View          | Minimap implementation                          | 05, 07       |
| 09    | Mobile Support      | Touch gestures, responsive layout               | 05, 06, 08   |
| 10    | Testing             | Unit, integration, E2E tests                    | All above    |
| 11    | Polish & Deploy     | Performance, final styling, deployment          | All above    |

## Task Files

```
plan/
├── 00-overview.md          # This file
├── 01-project-setup.md     # Phase 1: Scaffolding
├── 02-core-game-logic.md   # Phase 2: Edge math, state
├── 03-backend-server.md    # Phase 3: DO, APIs
├── 04-frontend-foundation.md # Phase 4: Layout, routing
├── 05-canvas-rendering.md  # Phase 5: Main canvas
├── 06-ui-components.md     # Phase 6: UI elements
├── 07-realtime-sync.md     # Phase 7: SSE, live updates
├── 08-world-view.md        # Phase 8: Minimap
├── 09-mobile-support.md    # Phase 9: Touch, responsive
├── 10-testing.md           # Phase 10: All tests
└── 11-polish-deploy.md     # Phase 11: Final steps
```

## Dependency Graph

```
01-project-setup
       │
       ├──────────────────┐
       ▼                  ▼
02-core-game-logic   04-frontend-foundation
       │                  │
       ├──────┬───────────┤
       ▼      ▼           ▼
03-backend  05-canvas  06-ui-components
       │      │           │
       └──────┼───────────┘
              ▼
       07-realtime-sync
              │
              ▼
       08-world-view
              │
              ▼
       09-mobile-support
              │
              ▼
       10-testing
              │
              ▼
       11-polish-deploy
```

## Estimated Effort

| Phase                  | Effort |
| ---------------------- | ------ |
| 01 Project Setup       | Small  |
| 02 Core Game Logic     | Medium |
| 03 Backend Server      | Medium |
| 04 Frontend Foundation | Small  |
| 05 Canvas Rendering    | Large  |
| 06 UI Components       | Medium |
| 07 Real-time Sync      | Medium |
| 08 World View          | Medium |
| 09 Mobile Support      | Medium |
| 10 Testing             | Large  |
| 11 Polish & Deploy     | Small  |

## Getting Started

Begin with `01-project-setup.md` and work through phases in order, respecting dependencies.
