#!/bin/bash
# Wrapper script to run the Ruby conformance adapter
# This is needed because the test runner spawns adapters as subprocesses
cd "$(dirname "$0")"

# Install dependencies if needed (redirect to stderr to avoid stdout noise)
if command -v bundle >/dev/null 2>&1; then
  if ! bundle check >/dev/null 2>&1; then
    bundle install --quiet 1>&2 || bundle install 1>&2
  fi

  exec bundle exec ruby conformance_adapter.rb
fi

# Fallback for environments without bundler
exec ruby conformance_adapter.rb
