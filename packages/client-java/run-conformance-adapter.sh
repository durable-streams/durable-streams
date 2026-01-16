#!/bin/bash
# Wrapper script to run the Java conformance adapter
# This is needed because the test runner spawns adapters as subprocesses

set -e
cd "$(dirname "$0")"

# Use Java 21 if available (Gradle 8.x doesn't support Java 24 yet)
if /usr/libexec/java_home -v 21 &>/dev/null; then
    export JAVA_HOME=$(/usr/libexec/java_home -v 21)
fi

# Check if the JAR exists, if not build it
JAR_PATH="conformance-adapter/build/libs/conformance-adapter.jar"

if [ ! -f "$JAR_PATH" ]; then
    echo "Building Java conformance adapter..." >&2
    # Pass native access flag to avoid JVM warnings on Java 22+ that corrupt stdout
    GRADLE_OPTS="${GRADLE_OPTS:-} --enable-native-access=ALL-UNNAMED"
    export GRADLE_OPTS
    if command -v gradle &> /dev/null; then
        gradle :conformance-adapter:jar --quiet >&2 2>&1
    elif [ -f "./gradlew" ]; then
        ./gradlew :conformance-adapter:jar --quiet >&2 2>&1
    else
        echo "Error: Gradle not found. Please install Gradle or run ./build.sh first." >&2
        exit 1
    fi
fi

# Run the adapter
# --enable-native-access=ALL-UNNAMED suppresses warnings about restricted native methods
# that would otherwise be printed to stdout and break the JSON-lines protocol
exec java --enable-native-access=ALL-UNNAMED -jar "$JAR_PATH"
