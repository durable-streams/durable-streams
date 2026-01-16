#!/bin/bash
# Wrapper script to run the Ruby conformance adapter
# This is needed because the test runner spawns adapters as subprocesses
cd "$(dirname "$0")"

# Install dependencies if needed (bundle install is fast when already installed)
bundle install --quiet 2>/dev/null || bundle install

exec bundle exec ruby conformance_adapter.rb
