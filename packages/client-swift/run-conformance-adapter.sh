#!/bin/bash
# Wrapper script to run the Swift conformance adapter
# Uses pre-built binary if available, otherwise falls back to Docker

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Check if the release binary exists (built by CI or locally via `swift build -c release`)
RELEASE_BINARY="$SCRIPT_DIR/.build/release/conformance-adapter"

if [ -x "$RELEASE_BINARY" ]; then
    # Use the pre-built binary directly
    exec "$RELEASE_BINARY"
fi

# Fall back to Docker for local development
# Build the Docker image if not exists or if sources changed
# Using a hash of source files to detect changes
if command -v md5sum >/dev/null 2>&1; then
    SOURCES_HASH=$(find "$SCRIPT_DIR/Sources" "$SCRIPT_DIR/Package.swift" -type f -exec md5sum {} \; 2>/dev/null | md5sum | cut -d' ' -f1 || echo "unknown")
else
    SOURCES_HASH=$(find "$SCRIPT_DIR/Sources" "$SCRIPT_DIR/Package.swift" -type f -exec md5 -q {} \; 2>/dev/null | md5 -q || echo "unknown")
fi
IMAGE_TAG="swift-conformance-adapter:${SOURCES_HASH:0:12}"

# Check if image exists
if ! docker image inspect "$IMAGE_TAG" >/dev/null 2>&1; then
    echo "Building Swift conformance adapter Docker image..." >&2
    docker build -t "$IMAGE_TAG" -t swift-conformance-adapter:latest "$SCRIPT_DIR" >&2
fi

# Run the adapter interactively (-i for stdin, no -t since we don't need a tty)
# DOCKER_HOST_REWRITE=1 tells the adapter to replace localhost with host.docker.internal
# This is needed on macOS where --network host doesn't work (uses a VM)
exec docker run -i --rm -e DOCKER_HOST_REWRITE=1 "$IMAGE_TAG"
