#!/bin/bash
# Wrapper script to run the Effect conformance adapter
# This is needed because the test runner spawns adapters as subprocesses
cd "$(dirname "$0")"
exec npx tsx test/adapter/effect-adapter.ts
