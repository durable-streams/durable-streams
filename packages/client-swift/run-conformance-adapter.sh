#!/bin/bash
# Wrapper script to run the Swift conformance adapter
# Uses pre-built binary if available, otherwise falls back to Docker
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Using a hash of source files to detect changes
if command -v md5sum >/dev/null 2>&1; then
    SOURCES_HASH=$(find "$SCRIPT_DIR/Sources" "$SCRIPT_DIR/Package.swift" -type f -exec md5sum {} \; 2>/dev/null | md5sum | cut -d' ' -f1 || echo "unknown")
else
    SOURCES_HASH=$(find "$SCRIPT_DIR/Sources" "$SCRIPT_DIR/Package.swift" -type f -exec md5 -q {} \; 2>/dev/null | md5 -q || echo "unknown")
fi

# Check if the release binary exists (built by CI or locally via `swift build -c release`)
RELEASE_BINARY="$SCRIPT_DIR/.build/release/conformance-adapter"
RELEASE_HASH_FILE="$SCRIPT_DIR/.build/release/conformance-adapter.sources-hash"

if [ -x "$RELEASE_BINARY" ] && [ -f "$RELEASE_HASH_FILE" ] && [ "$(cat "$RELEASE_HASH_FILE")" = "$SOURCES_HASH" ]; then
    # Use the pre-built binary directly
    exec "$RELEASE_BINARY"
fi

if command -v swift >/dev/null 2>&1; then
    if swift build -c release --product conformance-adapter --package-path "$SCRIPT_DIR" >&2; then
        if [ -x "$RELEASE_BINARY" ]; then
            printf '%s' "$SOURCES_HASH" > "$RELEASE_HASH_FILE"
            exec "$RELEASE_BINARY"
        fi
    fi
fi

# Fall back to Docker for local development
# Build the Docker image if not exists or if sources changed
IMAGE_TAG="swift-conformance-adapter:${SOURCES_HASH:0:12}"

# Build the hash-specific image if it does not exist.
if ! docker image inspect "$IMAGE_TAG" >/dev/null 2>&1; then
    echo "Building Swift conformance adapter Docker image..." >&2
    docker build -t "$IMAGE_TAG" -t swift-conformance-adapter:latest "$SCRIPT_DIR" >&2
fi

# Run the adapter interactively (-i for stdin, no -t since we don't need a tty)
DOCKER_ARGS=(-i --rm)
DOCKER_ENV=()

if [ "$(uname -s)" = "Linux" ]; then
  # Use host network to avoid iptables/NAT dependencies in minimal environments.
  DOCKER_ARGS+=(--network=host)
else
  # Rewrite localhost to host.docker.internal on platforms without host networking.
  DOCKER_ARGS+=(--add-host=host.docker.internal:host-gateway)
  DOCKER_ENV+=(-e DOCKER_HOST_REWRITE=1)
fi

exec docker run "${DOCKER_ARGS[@]}" "${DOCKER_ENV[@]}" "$IMAGE_TAG"
