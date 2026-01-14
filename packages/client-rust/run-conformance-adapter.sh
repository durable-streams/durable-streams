#!/bin/bash
# Wrapper script to run the Rust conformance adapter
# This is needed because the test runner spawns adapters as subprocesses
cd "$(dirname "$0")"
exec ./target/release/conformance-adapter
