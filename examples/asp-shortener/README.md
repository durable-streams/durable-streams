# asp-shortener

Cloudflare Worker that creates short URLs for agent coding sessions shared via [asp](../../packages/agent-session-protocol).

## How it works

- **POST `/api/create`** — client provides `{fullUrl, sessionId, entryCount, agent, token}`. The worker validates the URL host against `ALLOWED_DS_HOSTS`, validates the auth token by making a HEAD request to the DS URL, then generates a random short ID and stores the mapping in KV. Returns `{shortId, shortUrl}`.
- **GET `/:shortId`** — resolves the short URL:
  - Browsers (`Accept: text/html`) get a landing page with metadata and CLI instructions.
  - API clients (`Accept: application/json`) get the full DS URL as JSON.
- **GET `/`** — info page.

## Security model

Creation requires the DS auth token for the URL being registered. Only someone who already has access to the DS stream can create a short URL for it. The worker validates by hitting the DS URL itself, so no separate auth system is needed.

Resolution is public — anyone with a short URL can see metadata and get the full DS URL, but actually importing the session still requires the DS token.

## Setup

### 1. Install dependencies

```bash
pnpm install
```

### 2. Create a KV namespace

```bash
npx wrangler kv namespace create ASP_SHORTENER
```

This prints an ID. Copy it into `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "SHORTENER_KV"
id = "<the-id-from-above>"
```

### 3. Configure allowed DS hosts

Edit `wrangler.toml`:

```toml
[vars]
ALLOWED_DS_HOSTS = "api.electric-sql.cloud"
DEFAULT_TTL_SECONDS = "7776000"  # 90 days
```

Add any other DS hosts you want to allow (comma-separated).

### 4. Deploy

```bash
npx wrangler deploy
```

This deploys to `<worker-name>.<your-subdomain>.workers.dev`. For a custom domain, add a route in `wrangler.toml`:

```toml
[[routes]]
pattern = "share.example.com/*"
custom_domain = true
```

Or configure it in the Cloudflare dashboard under **Workers & Pages → asp-shortener → Custom Domains**.

### 5. Test it

Local dev:

```bash
npx wrangler dev
```

In another terminal, try creating a short URL:

```bash
curl -X POST http://localhost:8787/api/create \
  -H "content-type: application/json" \
  -d '{
    "fullUrl": "https://api.electric-sql.cloud/v1/stream/svc-xxx/asp/session-id/123-uuid",
    "sessionId": "session-id",
    "entryCount": 123,
    "agent": "claude",
    "token": "<valid-DS-token>"
  }'
```

Visit the returned short URL in a browser to see the landing page, or use `curl -H "accept: application/json" <short-url>` to see the JSON response.

## Using with asp

Once deployed, point `asp export` at the shortener:

```bash
asp export --server <ds-server> --token <token> --shortener https://share.example.com
```

Or set `ASP_SHORTENER` environment variable.

On import, asp auto-detects short URLs and resolves them:

```bash
asp import https://share.example.com/abc12345 --agent claude --token <token> --resume
```

## Files

- `src/worker.ts` — the Worker
- `wrangler.toml` — CF config (update with your KV namespace ID)
- `package.json` — dependencies
