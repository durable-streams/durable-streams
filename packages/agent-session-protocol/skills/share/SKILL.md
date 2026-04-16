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

## Steps

1. Determine the current session ID. The agent should use the session ID from its own context. For Claude Code, this is typically available as a UUID in the session metadata. For Codex, it's the thread ID.

2. Run the export:

   ```bash
   asp export --session <current-session-id>
   ```

   The agent type is auto-detected. If auto-detection fails, pass `--agent claude` or `--agent codex` explicitly.

3. Parse the output. The last line printed to stdout is the share URL, e.g.:

   ```
   https://streams.example.com/asp/<session-id>/<entry-count>-<uuid>
   ```

4. Tell the user:
   - A snapshot of this session has been shared at: **\<share-url\>**
   - To resume this share in Claude Code:
     ```bash
     asp import <share-url> --agent claude --resume
     ```
   - To resume this share in Codex:
     ```bash
     asp import <share-url> --agent codex --resume
     ```
   - Add `--token <token>` if the server requires auth (or set `ASP_TOKEN`)

## Notes

- Same-agent resume (Claude → Claude or Codex → Codex) is lossless — full history preserved via a native stream.
- Cross-agent resume (Claude → Codex or Codex → Claude) uses the normalized format — semantic content is preserved but tool calls are represented generically.
- The share URL is a snapshot. Future changes to the session require a new `asp export` to share.
