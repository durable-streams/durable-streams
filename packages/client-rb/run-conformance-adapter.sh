#!/bin/bash
# Wrapper script to run the Ruby conformance adapter
# This is needed because the test runner spawns adapters as subprocesses
cd "$(dirname "$0")"
exec ruby conformance_adapter.rb
