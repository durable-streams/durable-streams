#!/bin/bash
# Run the Elixir conformance adapter
# Requires the escript to be built first: mix escript.build

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$SCRIPT_DIR/conformance-adapter" "$@"
