#!/bin/bash
# Wrapper script to run the Python conformance adapter
# This is needed because the test runner spawns adapters as subprocesses
cd "$(dirname "$0")"
# Try uv first (for CI), fall back to python3
if command -v uv &> /dev/null; then
    exec uv run python conformance_adapter.py
else
    exec python3 conformance_adapter.py
fi
