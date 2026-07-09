#!/bin/bash
# Wrapper script to run the Rust conformance adapter
# This is needed because the test runner spawns adapters as subprocesses
set -euo pipefail

cd "$(dirname "$0")"

# Ensure rustup-managed toolchain is used (avoids Homebrew LLVM conflicts)
export PATH="$HOME/.cargo/bin:$PATH"

if [ ! -x ./target/release/conformance-adapter ]; then
  cargo build --release >&2
fi

exec ./target/release/conformance-adapter
