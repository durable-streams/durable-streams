#!/bin/bash
# Claude Code Stop Hook
# Called when Claude finishes responding - triggers idle timer

# Read hook input from stdin
input=$(cat)

# Parse the stop_hook_active flag
stop_hook_active=$(echo "$input" | jq -r '.stop_hook_active // true')

# Only notify if we have the required environment variables
if [ -n "$CLAUDE_WEB_API_URL" ] && [ -n "$CLAUDE_WEB_API_TOKEN" ] && [ -n "$SESSION_ID" ]; then
  # Notify API to start idle timer
  curl -s -X POST "${CLAUDE_WEB_API_URL}/api/sessions/${SESSION_ID}/idle" \
    -H "Authorization: Bearer ${CLAUDE_WEB_API_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"stopHookActive\": ${stop_hook_active}}" \
    > /dev/null 2>&1 || true
fi

exit 0
