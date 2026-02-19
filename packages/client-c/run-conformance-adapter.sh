#!/bin/bash
# Wrapper script to run the C conformance adapter
# This is needed because the test runner spawns adapters as subprocesses
cd "$(dirname "$0")"

# Build if needed
if [ ! -f build/conformance_adapter ]; then
    make adapter
fi

exec ./build/conformance_adapter
