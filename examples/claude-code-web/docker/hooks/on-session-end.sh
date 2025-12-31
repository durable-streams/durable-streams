#!/bin/bash
# Claude Code Session End Hook
# Called when the session ends - triggers immediate container termination

# Read hook input from stdin
input=$(cat)

# Parse the reason
reason=$(echo "$input" | jq -r '.reason // "unknown"')

# Only notify if we have the required environment variables
if [ -n "$CLAUDE_WEB_API_URL" ] && [ -n "$CLAUDE_WEB_API_TOKEN" ] && [ -n "$SESSION_ID" ]; then
  # Notify API for immediate termination
  curl -s -X POST "${CLAUDE_WEB_API_URL}/api/sessions/${SESSION_ID}/ended" \
    -H "Authorization: Bearer ${CLAUDE_WEB_API_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"reason\": \"${reason}\"}" \
    > /dev/null 2>&1 || true
fi

exit 0
