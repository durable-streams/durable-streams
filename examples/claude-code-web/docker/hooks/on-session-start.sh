#!/bin/bash
# Claude Code Session Start Hook
# Called when a new session starts - can be used for initialization

# Read hook input from stdin (contains session context)
input=$(cat)

# Log session start (for debugging)
if [ -n "$SESSION_ID" ]; then
  echo "[Claude Code Web] Session started: $SESSION_ID" >&2
fi

# Optional: Notify API that session has started
if [ -n "$CLAUDE_WEB_API_URL" ] && [ -n "$CLAUDE_WEB_API_TOKEN" ] && [ -n "$SESSION_ID" ]; then
  curl -s -X POST "${CLAUDE_WEB_API_URL}/api/sessions/${SESSION_ID}/started" \
    -H "Authorization: Bearer ${CLAUDE_WEB_API_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{}" \
    > /dev/null 2>&1 || true
fi

exit 0
