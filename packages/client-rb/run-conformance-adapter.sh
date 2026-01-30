#!/bin/bash
# Wrapper script to run the Ruby conformance adapter
# This is needed because the test runner spawns adapters as subprocesses
cd "$(dirname "$0")"

# Prefer running without bundler to avoid dev dependency installs.
if [ "${USE_BUNDLE:-0}" = "1" ] && command -v bundle >/dev/null 2>&1; then
  if ! bundle check >/dev/null 2>&1; then
    bundle install --quiet 1>&2 || bundle install 1>&2
  fi

  exec bundle exec ruby conformance_adapter.rb
fi

# Ensure runtime dependency is present when running directly.
if ! ruby -e "require 'net/http/persistent'" >/dev/null 2>&1; then
  gem install --user-install net-http-persistent --no-document 1>&2
fi

exec ruby conformance_adapter.rb
