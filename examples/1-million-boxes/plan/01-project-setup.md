# Phase 01: Project Setup

## Goal

Scaffold a TanStack Start project configured for Cloudflare Workers with Wrangler, including all dependencies and basic configuration.

## Dependencies

None — this is the starting point.

## Tasks

### 1.1 Initialize TanStack Start Project

```bash
cd examples/1-million-boxes
pnpm create @tanstack/start@latest .
```

Choose:

- React
- TypeScript
- No Tailwind (we're using plain CSS)

### 1.2 Install Dependencies

```bash
# Cloudflare
pnpm add -D @cloudflare/vite-plugin wrangler

# Base UI components
pnpm add @base-ui/react

# Utilities
pnpm add zod

# Dev dependencies
pnpm add -D vitest @testing-library/react playwright
```

### 1.3 Configure Vite for Cloudflare Workers

Create/update `vite.config.ts`:

```typescript
import { defineConfig } from "vite"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import { cloudflare } from "@cloudflare/vite-plugin"
import viteReact from "@vitejs/plugin-react"

export default defineConfig({
  plugins: [
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tanstackStart(),
    viteReact(),
  ],
})
```

### 1.4 Configure Wrangler

Create `wrangler.jsonc`:

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "1-million-boxes",
  "compatibility_date": "2025-01-22",
  "compatibility_flags": ["nodejs_compat"],
  "main": "@tanstack/react-start/server-entry",

  "durable_objects": {
    "bindings": [
      {
        "name": "GAME_WRITER",
        "class_name": "GameWriterDO",
      },
    ],
  },

  "rate_limits": [
    {
      "name": "draw-limit",
      "period": 60,
      "limit": 10,
    },
  ],
}
```

### 1.5 Create Environment Variables

Create `.dev.vars`:

```bash
DURABLE_STREAMS_URL=http://localhost:4437
TEAM_COOKIE_SECRET=dev-secret-change-in-production
```

Add to `.gitignore`:

```
.dev.vars
.wrangler/
```

### 1.6 Update Package Scripts

Update `package.json`:

```json
{
  "scripts": {
    "dev": "vite dev",
    "build": "vite build && tsc --noEmit",
    "preview": "vite preview",
    "deploy": "pnpm build && wrangler deploy",
    "cf-typegen": "wrangler types",
    "test": "vitest",
    "test:e2e": "playwright test"
  }
}
```

### 1.7 Create Directory Structure

```bash
mkdir -p src/{routes,components/{game,ui,layout},hooks,lib,styles,server}
mkdir -p tests/{e2e,integration}
mkdir -p public/textures
```

### 1.8 Create Basic CSS Setup

Create `src/styles/global.css`:

```css
:root {
  /* Team colors */
  --color-red: #e53935;
  --color-blue: #1e88e5;
  --color-green: #43a047;
  --color-yellow: #fdd835;

  /* UI colors */
  --color-bg: #f5f5dc;
  --color-text: #2d2d2d;
  --color-border: #8b8b7a;

  /* Spacing */
  --header-height: 48px;
  --footer-height: 56px;
  --minimap-size: 150px;
  --minimap-margin: 16px;

  /* Touch targets */
  --touch-min: 44px;
}

* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

body {
  font-family:
    system-ui,
    -apple-system,
    sans-serif;
  background-color: var(--color-bg);
  color: var(--color-text);
  overflow: hidden;
}
```

### 1.9 Verify Setup

```bash
# Start dev server
pnpm dev

# Should see TanStack Start app running on Cloudflare Workers runtime
```

## Deliverables

- [ ] TanStack Start project initialized
- [ ] All dependencies installed
- [ ] Vite configured with Cloudflare plugin
- [ ] Wrangler configured with DO binding
- [ ] Environment variables set up
- [ ] Directory structure created
- [ ] Basic CSS variables defined
- [ ] Dev server runs successfully

## Next Phase

→ `02-core-game-logic.md`
