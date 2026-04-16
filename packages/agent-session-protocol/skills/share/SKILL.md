---
name: share
description: Share the current agent session (Claude Code or Codex) via Durable Streams. Produces a URL that can be resumed in any supported agent. Supports two modes - "snapshot" (default) creates a frozen point-in-time copy, "live" creates a continuously-updated URL viewers can watch in real-time.
metadata:
  short-description: Share this session so it can be resumed elsewhere
---

# Share Agent Session

Export the current session to a Durable Stream. Produces a URL that can be imported into Claude Code, Codex, or any other supported agent — and optionally watched live in a browser.

## Modes

The user invokes the skill in one of two ways:

- **`/share`** (no argument) — **snapshot mode**. A frozen point-in-time copy of the session. Each invocation creates a new URL.
- **`/share live`** — **live mode**. A single URL that keeps updating as the session grows. The same URL is reused across invocations for the same session. Viewers can watch the conversation unfold in their browser. The watcher process runs in the background until killed.

If the user's argument is exactly `live` (case-insensitive), use live mode. Otherwise use snapshot mode.

## Prerequisites

The `asp` CLI must be available (from `@durable-streams/agent-session-protocol`).

The Durable Streams server URL must be configured via the `ASP_SERVER` environment variable, or passed with `--server`. If the server requires auth, set `ASP_TOKEN` or pass `--token`.

Optionally, a shortener URL can be configured via `ASP_SHORTENER` or `--shortener` — when set, the output is a short, human-friendly URL instead of the raw DS URL.

## Steps

1. Determine the current session ID from your own context. For Claude Code it's typically a UUID in the session metadata. For Codex it's the thread ID.

2. Run the appropriate command:

   **Snapshot** (`/share`):
   ```bash
   asp export --session <current-session-id>
   ```

   **Live** (`/share live`) — must be backgrounded with `&` so the agent session can continue:
   ```bash
   asp export --session <current-session-id> --live &
   ```

   Agent type is auto-detected. If auto-detection fails, pass `--agent claude` or `--agent codex` explicitly.

3. Parse stdout. The last printed line is the share URL. If a shortener is configured it's a short URL (e.g. `https://share.electric-sql.cloud/abc12345`); otherwise it's the full DS URL.

4. Tell the user, adapting based on mode:

   **Snapshot mode:**
   - A snapshot of this session has been shared at: **\<share-url\>**
   - Open the URL in a browser to see metadata and resume instructions. With a valid auth token, you can also watch the session content directly in the browser.
   - To resume from the CLI in Claude Code:
     ```bash
     asp import <share-url> --agent claude --resume
     ```
   - To resume from the CLI in Codex:
     ```bash
     asp import <share-url> --agent codex --resume
     ```

   **Live mode:**
   - This session is now being **live-shared** at: **\<share-url\>**
   - The share will keep updating as the conversation grows. Anyone with the URL can open it in a browser to watch the session unfold in real-time (with a valid auth token).
   - To stop sharing, kill the background `asp export --live` process.
   - To resume the current state from the CLI in Claude Code:
     ```bash
     asp import <share-url> --agent claude --resume
     ```
   - To resume the current state in Codex:
     ```bash
     asp import <share-url> --agent codex --resume
     ```
   - Resuming creates a snapshot of the session as it is at import time — it doesn't keep streaming updates.

In both cases, importing requires a valid auth token. Add `--token <token>` if needed (or set `ASP_TOKEN`).

## Notes

- Same-agent resume (Claude → Claude or Codex → Codex) is lossless — full history preserved via a native stream.
- Cross-agent resume (Claude → Codex or Codex → Claude) uses the normalized format — semantic content is preserved but tool calls are represented generically.
- Snapshot URLs are unique per export. Live URLs are stable per session.
