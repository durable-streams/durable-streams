#!/bin/bash
# Run the .NET conformance adapter via Docker
# This script acts as a stdin/stdout proxy to the Docker container

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE_NAME="durable-streams-dotnet-conformance"

# Build the Docker image if it doesn't exist or if --build is passed
if [[ "$1" == "--build" ]] || ! docker image inspect "$IMAGE_NAME" &>/dev/null; then
    echo "Building Docker image..." >&2
    docker build -t "$IMAGE_NAME" "$SCRIPT_DIR" >&2
fi

# Run the container interactively with stdin/stdout
# --rm: Remove container after exit
# -i: Keep stdin open
# DOCKER_HOST_OVERRIDE: Used by the adapter to rewrite localhost URLs to host.docker.internal
#                       (needed because --network host doesn't work on macOS Docker)
exec docker run --rm -i -e DOCKER_HOST_OVERRIDE=host.docker.internal "$IMAGE_NAME"
