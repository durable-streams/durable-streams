#!/usr/bin/env bash

set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
  cat <<'EOF' >&2
Usage: scripts/trace-claude-resume.sh <session-id> [cwd]

Launches `claude --resume <session-id>` from the given cwd, attaches `fs_usage`,
and filters filesystem activity down to Claude-related state paths.
EOF
  exit 1
fi

if ! command -v claude >/dev/null 2>&1; then
  echo "claude is not on PATH" >&2
  exit 1
fi

if ! command -v fs_usage >/dev/null 2>&1; then
  echo "fs_usage is not available on this machine" >&2
  exit 1
fi

SESSION_ID=$1
RUN_CWD=${2:-$PWD}
TRACE_DIR=$(mktemp -d "${TMPDIR:-/tmp}/trace-claude-resume.XXXXXX")
CLAUDE_STDOUT="$TRACE_DIR/claude.stdout"
CLAUDE_STDERR="$TRACE_DIR/claude.stderr"
TRACE_RAW_LOG="$TRACE_DIR/fs_usage.raw.log"
TRACE_LOG="$TRACE_DIR/fs_usage.filtered.log"
TRACE_FILTER="(/Users/$USER/\\.claude|/Users/$USER/Library/Application Support/Claude)"
CLAUDE_PID=""
TRACE_PID=""

cleanup() {
  if [[ -n "$TRACE_PID" ]] && kill -0 "$TRACE_PID" 2>/dev/null; then
    kill "$TRACE_PID" 2>/dev/null || true
    wait "$TRACE_PID" 2>/dev/null || true
  fi

  if [[ -n "$CLAUDE_PID" ]] && kill -0 "$CLAUDE_PID" 2>/dev/null; then
    kill "$CLAUDE_PID" 2>/dev/null || true
    wait "$CLAUDE_PID" 2>/dev/null || true
  fi
}

trap cleanup EXIT INT TERM

echo "Running Claude resume from: $RUN_CWD" >&2
echo "Tracing session id: $SESSION_ID" >&2
echo "Trace scratch dir: $TRACE_DIR" >&2

(
  cd "$RUN_CWD"
  claude \
    --print \
    --verbose \
    --output-format stream-json \
    --input-format stream-json \
    --permission-mode plan \
    --resume "$SESSION_ID" \
    -p ""
) >"$CLAUDE_STDOUT" 2>"$CLAUDE_STDERR" &
CLAUDE_PID=$!

for _ in $(seq 1 100); do
  if kill -0 "$CLAUDE_PID" 2>/dev/null; then
    break
  fi
  sleep 0.05
done

echo "Claude PID: $CLAUDE_PID" >&2
echo "Attaching fs_usage (sudo may prompt)..." >&2

sudo fs_usage -w -f filesys -f pathname -e "$CLAUDE_PID" 2>/dev/null \
  | tee "$TRACE_RAW_LOG" \
  | egrep "$TRACE_FILTER" \
  | tee "$TRACE_LOG" &
TRACE_PID=$!

CLAUDE_EXIT=0
if ! wait "$CLAUDE_PID"; then
  CLAUDE_EXIT=$?
fi

sleep 1

if kill -0 "$TRACE_PID" 2>/dev/null; then
  kill "$TRACE_PID" 2>/dev/null || true
  wait "$TRACE_PID" 2>/dev/null || true
fi

echo >&2
echo "=== Claude stdout ===" >&2
cat "$CLAUDE_STDOUT" >&2 || true

echo >&2
echo "=== Claude stderr ===" >&2
cat "$CLAUDE_STDERR" >&2 || true

echo >&2
echo "=== Saved traces ===" >&2
echo "$TRACE_RAW_LOG" >&2
echo "$TRACE_LOG" >&2

exit "$CLAUDE_EXIT"
