/**
 * asp-shortener — Cloudflare Worker that creates short URLs for shared
 * agent sessions stored in Durable Streams.
 *
 * Endpoints:
 *   POST /api/create   - Create a short URL (requires DS auth token)
 *   GET  /:shortId     - Resolve the short URL
 *                        - Accept: text/html      → landing page
 *                        - Accept: application/json → {fullUrl, metadata}
 *   GET  /             - Basic health/info page
 *
 * Security model:
 *   Creation requires the DS auth token for the URL being registered.
 *   The worker validates the token by making a HEAD request to the DS URL.
 *   Only someone who already has access to the DS stream can shorten it.
 */

interface Env {
  SHORTENER_KV: KVNamespace
  ALLOWED_DS_HOSTS: string
  DEFAULT_TTL_SECONDS: string
  ASSETS?: Fetcher
}

interface ShortUrlEntry {
  fullUrl: string
  sessionId: string
  entryCount: number
  agent: `claude` | `codex`
  createdAt: number
  live?: boolean
}

interface CreateRequest {
  fullUrl: string
  sessionId: string
  entryCount: number
  agent: `claude` | `codex`
  token: string
  live?: boolean
}

function sessionLiveIndexKey(sessionId: string): string {
  return `session:${sessionId}:live`
}

const SHORT_ID_LENGTH = 8
const SHORT_ID_ALPHABET =
  `ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789`
const MAX_CREATE_ATTEMPTS = 5

function generateShortId(): string {
  const chars = new Array(SHORT_ID_LENGTH)
  const bytes = new Uint8Array(SHORT_ID_LENGTH)
  crypto.getRandomValues(bytes)
  for (let i = 0; i < SHORT_ID_LENGTH; i++) {
    chars[i] = SHORT_ID_ALPHABET[bytes[i]! % SHORT_ID_ALPHABET.length]
  }
  return chars.join(``)
}

function isAllowedHost(url: string, allowedHosts: Array<string>): boolean {
  try {
    const parsed = new URL(url)
    return allowedHosts.includes(parsed.host)
  } catch {
    return false
  }
}

async function validateDsToken(
  fullUrl: string,
  token: string
): Promise<boolean> {
  try {
    const response = await fetch(fullUrl, {
      method: `HEAD`,
      headers: { Authorization: `Bearer ${token}` },
    })
    return response.ok
  } catch {
    return false
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": `application/json`,
      "access-control-allow-origin": `*`,
      "cache-control": `no-store`,
    },
  })
}

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": `*`,
    "access-control-allow-methods": `GET, POST, OPTIONS`,
    "access-control-allow-headers": `content-type, authorization`,
    "access-control-max-age": `86400`,
  }
}

function renderLandingPage(
  shortId: string,
  entry: ShortUrlEntry,
  requestUrl: URL
): Response {
  const shortUrl = `${requestUrl.origin}/${shortId}`

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Shared agent session · Electric</title>
  <style>
    :root {
      --c-bg: #0f1014;
      --c-bg-soft: #1a1d24;
      --c-bg-elv: #12151b;
      --c-text-1: rgba(255, 255, 245, 0.92);
      --c-text-2: rgba(235, 235, 245, 0.68);
      --c-text-3: rgba(235, 235, 245, 0.48);
      --c-border: rgba(84, 84, 84, 0.3);
      --c-brand: #00d2a0;
      --c-brand-hover: #00b489;
      --c-code: #9ecbff;
      --font-sans: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif;
      --font-mono: "SourceCodePro", ui-monospace, "SF Mono", Menlo, Monaco, Consolas, monospace;
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }

    html, body {
      background-color: var(--c-bg);
      color: var(--c-text-1);
      font-family: var(--font-sans);
      font-weight: 400;
      line-height: 1.6;
      font-size: 16px;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }

    .container {
      max-width: 720px;
      margin: 0 auto;
      padding: 3rem 1.5rem 4rem;
    }

    .brand {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      font-size: 0.85rem;
      font-weight: 600;
      color: var(--c-text-2);
      letter-spacing: 0.02em;
      text-transform: uppercase;
      margin-bottom: 2rem;
    }
    .brand-dot {
      display: inline-block;
      width: 0.5rem;
      height: 0.5rem;
      border-radius: 50%;
      background: var(--c-brand);
      box-shadow: 0 0 12px var(--c-brand);
    }

    h1 {
      font-size: 2.25rem;
      font-weight: 700;
      line-height: 1.2;
      letter-spacing: -0.02em;
      margin-bottom: 0.75rem;
    }

    h2 {
      font-size: 1rem;
      font-weight: 600;
      line-height: 1.3;
      color: var(--c-text-1);
      margin-top: 2.5rem;
      margin-bottom: 0.75rem;
      letter-spacing: 0.01em;
    }

    .lede {
      color: var(--c-text-2);
      font-size: 1.05rem;
      margin-bottom: 2.5rem;
    }

    .lede strong { color: var(--c-brand); font-weight: 600; }

    .meta {
      display: grid;
      grid-template-columns: max-content 1fr;
      gap: 0.5rem 1.5rem;
      margin: 0 0 0.5rem;
      padding: 1.25rem 1.5rem;
      background: var(--c-bg-soft);
      border: 1px solid var(--c-border);
      border-radius: 12px;
      font-size: 0.9rem;
    }
    .meta dt {
      color: var(--c-text-3);
      font-size: 0.8rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      align-self: center;
    }
    .meta dd {
      margin: 0;
      font-family: var(--font-mono);
      color: var(--c-text-1);
      word-break: break-all;
    }
    .meta dd.agent { font-family: var(--font-sans); font-weight: 600; color: var(--c-brand); text-transform: capitalize; }

    .prereq {
      margin-top: 2.5rem;
      padding: 1.25rem 1.5rem;
      background: rgba(0, 210, 160, 0.04);
      border: 1px solid rgba(0, 210, 160, 0.2);
      border-radius: 12px;
    }
    .prereq h2 {
      margin-top: 0;
      margin-bottom: 0.25rem;
      color: var(--c-brand);
      font-size: 0.8rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .prereq-intro {
      color: var(--c-text-2);
      font-size: 0.95rem;
      margin: 0 0 1rem;
    }
    .prereq .code-block { margin: 0; }

    code {
      font-family: var(--font-mono);
      font-size: 0.85em;
      color: var(--c-code);
    }

    .code-block {
      position: relative;
      margin: 0.5rem 0;
    }
    .code-block pre {
      background: var(--c-bg-elv);
      border: 1px solid var(--c-border);
      padding: 1rem 3rem 1rem 1.25rem;
      border-radius: 12px;
      overflow-x: auto;
      white-space: pre-wrap;
      word-break: break-all;
      margin: 0;
      font-family: var(--font-mono);
      font-size: 0.85rem;
      color: var(--c-code);
      line-height: 1.6;
    }
    .copy-btn {
      position: absolute;
      top: 0.5rem;
      right: 0.5rem;
      width: 2.1rem;
      height: 2.1rem;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: var(--c-bg-soft);
      border: 1px solid var(--c-border);
      border-radius: 8px;
      cursor: pointer;
      color: var(--c-text-2);
      transition: all 0.2s;
      padding: 0;
    }
    .copy-btn:hover {
      background: var(--c-bg-elv);
      color: var(--c-text-1);
      border-color: rgba(84, 84, 84, 0.5);
    }
    .copy-btn svg { width: 14px; height: 14px; }
    .copy-btn.copied {
      color: var(--c-brand);
      border-color: var(--c-brand);
    }

    .subtle {
      color: var(--c-text-3);
      font-size: 0.9rem;
      margin-top: 2.5rem;
      padding-top: 1.5rem;
      border-top: 1px solid var(--c-border);
    }
    .subtle a {
      color: var(--c-text-2);
      text-decoration: underline;
      text-underline-offset: 2px;
      transition: color 0.2s;
    }
    .subtle a:hover { color: var(--c-brand); }

    @media (max-width: 520px) {
      h1 { font-size: 1.75rem; }
      .container { padding: 2rem 1rem 3rem; }
      .meta { grid-template-columns: 1fr; gap: 0.25rem; padding: 1rem; }
      .meta dt { margin-top: 0.5rem; }
      .meta dt:first-child { margin-top: 0; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="brand">
      <span class="brand-dot"></span>
      <span>Electric</span>
    </div>

    <h1>Shared agent session</h1>
    <p class="lede">A snapshot of an agent coding session, shared via Electric.</p>

    <dl class="meta">
      <dt>Agent</dt>
      <dd class="agent">${entry.agent}</dd>
      <dt>Events</dt>
      <dd>${entry.entryCount}</dd>
      <dt>Shared</dt>
      <dd><span data-ts="${entry.createdAt}">${new Date(entry.createdAt).toISOString()}</span></dd>
      <dt>Session</dt>
      <dd>${entry.sessionId}</dd>
    </dl>

    <div class="prereq">
      <h2>Prerequisites</h2>
      <p class="prereq-intro">
        To resume this session you need the <code>asp</code> CLI installed and
        a valid auth token for the underlying Durable Streams server.
      </p>
      <div class="code-block">
        <pre>npm install -g @durable-streams/agent-session-protocol</pre>
        <button class="copy-btn" data-copy="npm install -g @durable-streams/agent-session-protocol" aria-label="Copy"></button>
      </div>
    </div>

    <h2>Resume in Claude Code</h2>
    <div class="code-block">
      <pre>asp import ${shortUrl} --agent claude --token &lt;your-token&gt; --resume</pre>
      <button class="copy-btn" data-copy="asp import ${shortUrl} --agent claude --token <your-token> --resume" aria-label="Copy"></button>
    </div>

    <h2>Resume in Codex</h2>
    <div class="code-block">
      <pre>asp import ${shortUrl} --agent codex --token &lt;your-token&gt; --resume</pre>
      <button class="copy-btn" data-copy="asp import ${shortUrl} --agent codex --token <your-token> --resume" aria-label="Copy"></button>
    </div>

    <p class="subtle">
      You need a valid auth token to actually import the session.
    </p>
  </div>

  <script>
    // Render timestamp in user's local timezone
    (function() {
      const el = document.querySelector('[data-ts]');
      if (!el) return;
      const ts = parseInt(el.getAttribute('data-ts'), 10);
      if (!Number.isFinite(ts)) return;
      const d = new Date(ts);
      const formatter = new Intl.DateTimeFormat(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        timeZoneName: 'short',
      });
      el.textContent = formatter.format(d);
    })();

    // Copy-to-clipboard for code blocks
    const COPY_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
    const CHECK_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';

    document.querySelectorAll('.copy-btn').forEach(function(btn) {
      btn.innerHTML = COPY_ICON;
      btn.addEventListener('click', function() {
        const text = btn.getAttribute('data-copy') || '';
        navigator.clipboard.writeText(text).then(function() {
          btn.innerHTML = CHECK_ICON;
          btn.classList.add('copied');
          btn.setAttribute('aria-label', 'Copied!');
          setTimeout(function() {
            btn.innerHTML = COPY_ICON;
            btn.classList.remove('copied');
            btn.setAttribute('aria-label', 'Copy');
          }, 1500);
        });
      });
    });
  </script>
</body>
</html>`

  return new Response(html, {
    status: 200,
    headers: {
      "content-type": `text/html; charset=utf-8`,
      "cache-control": `public, max-age=60`,
    },
  })
}

async function handleCreate(request: Request, env: Env): Promise<Response> {
  if (request.method !== `POST`) {
    return jsonResponse({ error: `method not allowed` }, 405)
  }

  let body: CreateRequest
  try {
    body = (await request.json()) as CreateRequest
  } catch {
    return jsonResponse({ error: `invalid JSON body` }, 400)
  }

  const { fullUrl, sessionId, entryCount, agent, token, live } = body

  if (!fullUrl || !sessionId || typeof entryCount !== `number` || !agent || !token) {
    return jsonResponse(
      { error: `missing required fields: fullUrl, sessionId, entryCount, agent, token` },
      400
    )
  }

  if (agent !== `claude` && agent !== `codex`) {
    return jsonResponse({ error: `invalid agent: must be "claude" or "codex"` }, 400)
  }

  const allowedHosts = env.ALLOWED_DS_HOSTS.split(`,`).map((h) => h.trim())
  if (!isAllowedHost(fullUrl, allowedHosts)) {
    return jsonResponse(
      {
        error: `URL host not allowed`,
        allowed: allowedHosts,
      },
      400
    )
  }

  const tokenValid = await validateDsToken(fullUrl, token)
  if (!tokenValid) {
    return jsonResponse({ error: `token not valid for URL` }, 403)
  }

  const url = new URL(request.url)
  const ttlSeconds = parseInt(env.DEFAULT_TTL_SECONDS, 10)

  // For live shares: idempotent registration. If a live share already exists
  // for this session, return the existing short URL.
  if (live === true) {
    const existingId = await env.SHORTENER_KV.get(sessionLiveIndexKey(sessionId))
    if (existingId) {
      const existingRaw = await env.SHORTENER_KV.get(existingId)
      if (existingRaw) {
        return jsonResponse({
          shortId: existingId,
          shortUrl: `${url.origin}/${existingId}`,
        })
      }
      // Stale index — fall through to create a new entry
    }
  }

  // Generate a unique short ID
  let shortId: string | null = null
  for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt++) {
    const candidate = generateShortId()
    const existing = await env.SHORTENER_KV.get(candidate)
    if (existing === null) {
      shortId = candidate
      break
    }
  }

  if (!shortId) {
    return jsonResponse(
      { error: `failed to generate unique short ID, try again` },
      500
    )
  }

  const entry: ShortUrlEntry = {
    fullUrl,
    sessionId,
    entryCount,
    agent,
    createdAt: Date.now(),
    live: live === true,
  }

  await env.SHORTENER_KV.put(shortId, JSON.stringify(entry), {
    expirationTtl: ttlSeconds > 0 ? ttlSeconds : undefined,
  })

  // For live shares, also write the secondary index for cross-linking.
  if (live === true) {
    await env.SHORTENER_KV.put(sessionLiveIndexKey(sessionId), shortId, {
      expirationTtl: ttlSeconds > 0 ? ttlSeconds : undefined,
    })
  }

  return jsonResponse({ shortId, shortUrl: `${url.origin}/${shortId}` })
}

async function lookupLiveShareForSession(
  sessionId: string,
  selfShortId: string,
  env: Env
): Promise<string | null> {
  const liveShortId = await env.SHORTENER_KV.get(sessionLiveIndexKey(sessionId))
  if (!liveShortId || liveShortId === selfShortId) return null
  const entryRaw = await env.SHORTENER_KV.get(liveShortId)
  if (!entryRaw) return null
  return liveShortId
}

async function handleResolve(
  shortId: string,
  request: Request,
  env: Env
): Promise<Response> {
  const raw = await env.SHORTENER_KV.get(shortId)
  if (!raw) {
    return jsonResponse({ error: `short URL not found` }, 404)
  }

  const entry = JSON.parse(raw) as ShortUrlEntry
  const url = new URL(request.url)

  // Look up live share for cross-linking (only relevant on snapshot pages)
  const liveShortId =
    entry.live === true
      ? null
      : await lookupLiveShareForSession(entry.sessionId, shortId, env)
  const liveShareUrl = liveShortId ? `${url.origin}/${liveShortId}` : null

  // Content negotiation: JSON for CLI/API, HTML for browsers
  const accept = request.headers.get(`accept`) ?? ``
  const wantsJson =
    accept.includes(`application/json`) &&
    !accept.includes(`text/html`)

  if (wantsJson) {
    return jsonResponse({
      fullUrl: entry.fullUrl,
      sessionId: entry.sessionId,
      entryCount: entry.entryCount,
      agent: entry.agent,
      createdAt: entry.createdAt,
      live: entry.live === true,
      liveShareUrl,
    })
  }

  // Browser request: serve the SPA (viewer/dist/index.html) if assets are
  // bound; otherwise fall back to the legacy server-rendered landing page.
  //
  // Note: we fetch `/` (not `/index.html`) because the assets binding's
  // default `html_handling = "auto-trailing-slash"` will 307-redirect
  // `/index.html` → `/`, and we'd pass that redirect through to the user
  // (whose URL bar shows /<shortId>, so they'd land on / and lose context).
  if (env.ASSETS) {
    const indexUrl = new URL(`/`, url.origin)
    return env.ASSETS.fetch(new Request(indexUrl, request))
  }
  return renderLandingPage(shortId, entry, url)
}

function handleRoot(): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Share · Electric</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #0f1014;
      color: rgba(255, 255, 245, 0.92);
      font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif;
      line-height: 1.6;
      -webkit-font-smoothing: antialiased;
    }
    .container {
      max-width: 560px;
      margin: 0 auto;
      padding: 4rem 1.5rem;
    }
    .brand {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      font-size: 0.85rem;
      font-weight: 600;
      color: rgba(235, 235, 245, 0.68);
      letter-spacing: 0.02em;
      text-transform: uppercase;
      margin-bottom: 2rem;
    }
    .brand-dot {
      display: inline-block;
      width: 0.5rem;
      height: 0.5rem;
      border-radius: 50%;
      background: #00d2a0;
      box-shadow: 0 0 12px #00d2a0;
    }
    h1 { font-size: 1.75rem; font-weight: 700; letter-spacing: -0.02em; margin-bottom: 0.75rem; }
    p { color: rgba(235, 235, 245, 0.68); margin-bottom: 1rem; }
    code {
      font-family: ui-monospace, "SF Mono", Menlo, monospace;
      background: #12151b;
      border: 1px solid rgba(84, 84, 84, 0.3);
      color: #9ecbff;
      padding: 0.15rem 0.4rem;
      border-radius: 4px;
      font-size: 0.85rem;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="brand">
      <span class="brand-dot"></span>
      <span>Electric</span>
    </div>
    <h1>Share agent sessions</h1>
    <p>Short URLs for agent coding sessions shared via <code>asp</code> (agent-session-protocol).</p>
    <p>Use <code>asp export --shortener &lt;this-url&gt;</code> to create short URLs.</p>
  </div>
</body>
</html>`

  return new Response(html, {
    status: 200,
    headers: { "content-type": `text/html; charset=utf-8` },
  })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === `OPTIONS`) {
      return new Response(null, { status: 204, headers: corsHeaders() })
    }

    const url = new URL(request.url)
    const path = url.pathname

    if (path === `/` || path === ``) {
      return handleRoot()
    }

    if (path === `/api/create`) {
      return handleCreate(request, env)
    }

    // Treat any other single-segment path as a short ID
    const match = path.match(/^\/([A-Za-z0-9]+)\/?$/)
    if (match) {
      return handleResolve(match[1]!, request, env)
    }

    return jsonResponse({ error: `not found` }, 404)
  },
} satisfies ExportedHandler<Env>
