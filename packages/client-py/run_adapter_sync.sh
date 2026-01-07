#!/bin/bash
cd "$(dirname "$0")"
export DURABLE_STREAMS_SYNC=1
exec uv run python conformance_adapter.py
