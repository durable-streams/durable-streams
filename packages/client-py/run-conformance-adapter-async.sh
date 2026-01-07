#!/bin/bash
# Wrapper script to run the async Python conformance adapter
# This is needed because the test runner spawns adapters as subprocesses
cd "$(dirname "$0")"
exec uv run python conformance_adapter_async.py
