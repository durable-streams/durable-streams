#!/bin/bash
cd "$(dirname "$0")"
exec uv run python conformance_adapter.py
