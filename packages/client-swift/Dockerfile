# Dockerfile for Swift Durable Streams conformance adapter
# Usage: docker build -t swift-conformance-adapter .
# Run:   docker run -i --rm swift-conformance-adapter

FROM swift:6.0

WORKDIR /app

# Copy package manifest first for caching
COPY Package.swift .

# Copy source files
COPY Sources/ Sources/
COPY Tests/ Tests/

# Build the conformance adapter in release mode
RUN swift build -c release --product conformance-adapter

# The adapter communicates via stdin/stdout
ENTRYPOINT [".build/release/conformance-adapter"]
