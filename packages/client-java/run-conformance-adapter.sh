#!/bin/bash
# Wrapper script to run the Java conformance adapter
# This is needed because the test runner spawns adapters as subprocesses

set -e
cd "$(dirname "$0")"

# Check if the JAR exists, if not build it
JAR_PATH="conformance-adapter/build/libs/conformance-adapter.jar"

if [ ! -f "$JAR_PATH" ]; then
    echo "Building Java conformance adapter..." >&2
    if command -v gradle &> /dev/null; then
        gradle :conformance-adapter:jar --quiet 2>&1 >&2
    elif [ -f "./gradlew" ]; then
        ./gradlew :conformance-adapter:jar --quiet 2>&1 >&2
    else
        echo "Error: Gradle not found. Please install Gradle or run ./build.sh first." >&2
        exit 1
    fi
fi

# Run the adapter
exec java -jar "$JAR_PATH"
