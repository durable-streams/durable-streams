#!/bin/bash
# Run the Elixir conformance adapter
# Builds the escript if not present

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Build the escript if missing
if [ ! -x ./conformance-adapter ]; then
  mix escript.build >&2
fi

exec ./conformance-adapter "$@"
