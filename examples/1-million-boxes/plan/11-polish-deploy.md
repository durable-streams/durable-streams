# Phase 11: Polish & Deploy

## Goal

Final polish, performance optimization, and deployment to Cloudflare Workers.

## Dependencies

- All previous phases

## Tasks

### 11.1 Performance Optimization

#### Canvas Rendering

Update rendering for performance:

```typescript
// src/components/game/GameCanvas.tsx

// Use requestAnimationFrame efficiently
useEffect(
  () => {
    let animationId: number
    let lastRenderTime = 0
    const MIN_FRAME_TIME = 1000 / 60 // 60 FPS max

    const render = (timestamp: number) => {
      if (timestamp - lastRenderTime >= MIN_FRAME_TIME) {
        renderFrame()
        lastRenderTime = timestamp
      }
      animationId = requestAnimationFrame(render)
    }

    animationId = requestAnimationFrame(render)

    return () => cancelAnimationFrame(animationId)
  },
  [
    /* dependencies */
  ]
)

// Batch state updates
const pendingEvents = useRef<GameEvent[]>([])
const flushEvents = useCallback(() => {
  if (pendingEvents.current.length > 0) {
    const events = pendingEvents.current
    pendingEvents.current = []
    applyEvents(events)
  }
}, [applyEvents])

// Throttle minimap updates
const throttledMinimapUpdate = useMemo(
  () => throttle(() => minimapRenderer.render(), 100),
  [minimapRenderer]
)
```

#### Lazy Loading

```typescript
// src/routes/index.tsx
import { lazy, Suspense } from 'react';

const GameCanvas = lazy(() => import('../components/game/GameCanvas'));
const WorldView = lazy(() => import('../components/game/WorldView'));

function GamePage() {
  return (
    <div className="game-layout">
      <Header />
      <main className="game-main">
        <Suspense fallback={<div className="loading">Loading...</div>}>
          <GameCanvas />
          <WorldView />
        </Suspense>
      </main>
      <Footer />
    </div>
  );
}
```

### 11.2 Error Boundary

Create `src/components/ErrorBoundary.tsx`:

```tsx
import { Component, ReactNode } from "react"

interface Props {
  children: ReactNode
  fallback?: ReactNode
}

interface State {
  hasError: boolean
  error?: Error
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("Error caught by boundary:", error, info)
  }

  render() {
    if (this.state.hasError) {
      return (
        this.props.fallback || (
          <div className="error-fallback">
            <h1>Something went wrong</h1>
            <p>Please refresh the page to try again.</p>
            <button onClick={() => window.location.reload()}>Refresh</button>
          </div>
        )
      )
    }

    return this.props.children
  }
}
```

### 11.3 Loading States

Create `src/components/ui/LoadingSpinner.tsx`:

```tsx
import "./LoadingSpinner.css"

export function LoadingSpinner({
  size = "medium",
}: {
  size?: "small" | "medium" | "large"
}) {
  return (
    <div className={`loading-spinner ${size}`}>
      <div className="spinner"></div>
    </div>
  )
}
```

Create `src/components/ui/LoadingSpinner.css`:

```css
.loading-spinner {
  display: flex;
  align-items: center;
  justify-content: center;
}

.spinner {
  border-radius: 50%;
  border-style: solid;
  border-color: var(--color-border);
  border-top-color: var(--color-blue);
  animation: spin 0.8s linear infinite;
}

.loading-spinner.small .spinner {
  width: 16px;
  height: 16px;
  border-width: 2px;
}

.loading-spinner.medium .spinner {
  width: 32px;
  height: 32px;
  border-width: 3px;
}

.loading-spinner.large .spinner {
  width: 48px;
  height: 48px;
  border-width: 4px;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
```

### 11.4 SEO and Meta Tags

Update `index.html`:

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta
      name="viewport"
      content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover"
    />

    <!-- SEO -->
    <title>1 Million Boxes - Global Dots & Boxes Game</title>
    <meta
      name="description"
      content="Play the world's largest game of Dots & Boxes. Join one of four teams and compete to claim the most boxes on a 1000×1000 grid."
    />

    <!-- Open Graph -->
    <meta property="og:title" content="1 Million Boxes" />
    <meta
      property="og:description"
      content="The world's largest multiplayer Dots & Boxes game"
    />
    <meta property="og:image" content="/og-image.png" />
    <meta property="og:type" content="website" />

    <!-- Twitter -->
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="1 Million Boxes" />
    <meta
      name="twitter:description"
      content="The world's largest multiplayer Dots & Boxes game"
    />
    <meta name="twitter:image" content="/og-image.png" />

    <!-- PWA -->
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-status-bar-style" content="default" />
    <meta name="apple-mobile-web-app-title" content="1M Boxes" />
    <meta name="theme-color" content="#F5F5DC" />
    <link rel="manifest" href="/manifest.json" />

    <!-- Icons -->
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

Create `public/manifest.json`:

```json
{
  "name": "1 Million Boxes",
  "short_name": "1M Boxes",
  "description": "The world's largest multiplayer Dots & Boxes game",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#F5F5DC",
  "theme_color": "#F5F5DC",
  "icons": [
    {
      "src": "/icon-192.png",
      "sizes": "192x192",
      "type": "image/png"
    },
    {
      "src": "/icon-512.png",
      "sizes": "512x512",
      "type": "image/png"
    }
  ]
}
```

### 11.5 Production Environment Variables

Create `.env.production`:

```bash
VITE_DURABLE_STREAMS_URL=https://your-project.electric-sql.com
```

### 11.6 Deployment Checklist

Create `DEPLOY.md`:

````markdown
# Deployment Checklist

## Pre-deployment

- [ ] All tests passing (`pnpm test:all`)
- [ ] No TypeScript errors (`pnpm build`)
- [ ] Environment variables set in Cloudflare dashboard:
  - `DURABLE_STREAMS_URL`
  - `TEAM_COOKIE_SECRET`
- [ ] Icons and OG images created

## Deploy

```bash
# Login to Cloudflare (if not already)
pnpm dlx wrangler login

# Deploy
pnpm deploy
```
````

## Post-deployment

- [ ] Verify app loads at production URL
- [ ] Test team assignment (new incognito window)
- [ ] Test edge placement
- [ ] Test real-time sync (two browsers)
- [ ] Test mobile layout
- [ ] Verify Durable Streams connection
- [ ] Check rate limiting works

## Rollback

If issues:

```bash
wrangler rollback
```

````

### 11.7 Final CSS Polish

Update `src/styles/global.css`:

```css
/* Add smooth transitions */
* {
  box-sizing: border-box;
}

/* Improve focus states for accessibility */
:focus-visible {
  outline: 2px solid var(--color-blue);
  outline-offset: 2px;
}

button:focus-visible {
  outline: 2px solid var(--color-blue);
  outline-offset: 2px;
}

/* Smooth scrolling */
html {
  scroll-behavior: smooth;
}

/* Better font rendering */
body {
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  text-rendering: optimizeLegibility;
}

/* Selection color */
::selection {
  background: var(--color-blue);
  color: white;
}

/* Print styles */
@media print {
  .header, .footer, .zoom-controls, .world-view {
    display: none;
  }
}
````

### 11.8 Accessibility Audit

Ensure all interactive elements have:

- Proper ARIA labels
- Keyboard navigation
- Sufficient color contrast
- Focus indicators

```tsx
// Example: Accessible button
<button
  onClick={handleClick}
  aria-label="Place edge"
  aria-disabled={remaining === 0}
  tabIndex={0}
  onKeyDown={(e) => e.key === "Enter" && handleClick()}
>
  ...
</button>
```

### 11.9 Analytics (Optional)

If using analytics:

```typescript
// src/lib/analytics.ts
export function trackEvent(name: string, properties?: Record<string, any>) {
  if (typeof window !== "undefined" && window.gtag) {
    window.gtag("event", name, properties)
  }
}

// Usage
trackEvent("edge_placed", { teamId, edgeId })
trackEvent("box_claimed", { teamId, boxId })
```

### 11.10 Final Build and Deploy

```bash
# Final build
pnpm build

# Preview locally
pnpm preview

# Deploy to Cloudflare
pnpm deploy
```

## Deliverables

- [ ] Performance optimizations applied
- [ ] Error boundary implemented
- [ ] Loading states added
- [ ] SEO meta tags complete
- [ ] PWA manifest created
- [ ] Production env vars configured
- [ ] Deployment checklist created
- [ ] CSS polish complete
- [ ] Accessibility audit passed
- [ ] App deployed to Cloudflare Workers
- [ ] Production URL working

## Post-Launch

After launch:

1. Monitor error rates
2. Watch stream growth
3. Check rate limiting effectiveness
4. Gather user feedback
5. Plan next iteration
