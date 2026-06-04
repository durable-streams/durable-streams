#!/bin/bash
# Wrapper script to run the Go conformance adapter.
set -euo pipefail

cd "$(dirname "$0")"
exec go run ./cmd/conformance-adapter
