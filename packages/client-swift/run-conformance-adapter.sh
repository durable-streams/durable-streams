#!/bin/bash
# Wrapper script to run the Swift conformance adapter
# This is needed because the test runner spawns adapters as subprocesses
cd "$(dirname "$0")"
exec .build/release/conformance-adapter
