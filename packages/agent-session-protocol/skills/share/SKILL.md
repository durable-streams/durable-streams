---
name: share
description: Share the current agent session (Claude Code or Codex) via Durable Streams. Produces a URL that can be resumed in any supported agent.
metadata:
  short-description: Share this session so it can be resumed elsewhere
---

# Share Agent Session

Export the current session to a Durable Stream. Produces a URL that can be imported into Claude Code, Codex, or any other supported agent.

## Prerequisites

The `asp` CLI must be available (from `@durable-streams/agent-session-protocol`).

The Durable Streams server URL must be configured via the `ASP_SERVER` environment variable, or passed with `--server`. If the server requires auth, set `ASP_TOKEN` or pass `--token`.

Optionally, a shortener URL can be configured via `ASP_SHORTENER` or `--shortener` — when set, the output is a short, human-friendly URL instead of the raw DS URL.

## Steps

1. Determine the current session ID. The agent should use the session ID from its own context. For Claude Code, this is typically available as a UUID in the session metadata. For Codex, it's the thread ID.

2. Run the export:

   ```bash
   asp export --session <current-session-id>
   ```

   The agent type is auto-detected. If auto-detection fails, pass `--agent claude` or `--agent codex` explicitly.

3. Parse the output. The last line printed to stdout is the share URL. Determine whether it's a short URL or the full DS URL — short URLs are noticeably shorter and live on a different domain (e.g. `share.electric-sql.cloud`) while full DS URLs include `/asp/<session-id>/<share-id>` path segments.

4. Tell the user, adapting the message based on URL type:

   **If a short URL was produced (shortener was configured):**

   - A snapshot of this session has been shared at: **\<short-url\>**
   - Share this URL with anyone — opening it in a browser shows a landing page with session metadata and resume instructions.
   - To resume from the CLI in Claude Code:
     ```bash
     asp import <short-url> --agent claude --resume
     ```
   - To resume from the CLI in Codex:
     ```bash
     asp import <short-url> --agent codex --resume
     ```
   - Importing still requires a valid auth token for the underlying Durable Streams server. Add `--token <token>` if needed (or set `ASP_TOKEN`).

   **If only the full DS URL was produced (no shortener):**

   - A snapshot of this session has been shared at: **\<full-url\>**
   - To resume in Claude Code:
     ```bash
     asp import <full-url> --agent claude --resume
     ```
   - To resume in Codex:
     ```bash
     asp import <full-url> --agent codex --resume
     ```
   - Add `--token <token>` if the server requires auth (or set `ASP_TOKEN`).

## Notes

- Same-agent resume (Claude → Claude or Codex → Codex) is lossless — full history preserved via a native stream.
- Cross-agent resume (Claude → Codex or Codex → Claude) uses the normalized format — semantic content is preserved but tool calls are represented generically.
- The share URL is a snapshot. Future changes to the session require a new `asp export` to share.
