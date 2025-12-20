# @durable-streams/client-conformance-tests

Conformance test suite for Durable Streams client implementations (producer and consumer).

This package provides a comprehensive test suite to verify that a client correctly implements the [Durable Streams protocol](../../PROTOCOL.md) across any programming language.

## How It Works

The conformance suite uses a **language-agnostic architecture** inspired by [ConnectRPC Conformance](https://github.com/connectrpc/conformance) and [AWS Smithy Protocol Tests](https://smithy.io/2.0/additional-specs/http-protocol-compliance-tests.html):

```
┌─────────────────────────────────────────────────────────────────┐
│                    Test Runner (Node.js)                        │
│  - Reads test cases from YAML                                  │
│  - Manages reference server lifecycle                          │
│  - Orchestrates client adapter process                         │
│  - Compares results against expectations                       │
└────────────────────────┬────────────────────────────────────────┘
                         │ stdin/stdout (JSON lines)
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│              Client Adapter (any language)                      │
│  - Reads test commands from stdin                              │
│  - Uses native SDK to execute operations                       │
│  - Reports results to stdout                                   │
└─────────────────────────────────────────────────────────────────┘
                         │ HTTP
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│              Reference Server (TypeScript)                      │
│  - Full protocol compliance                                    │
│  - Validates client behavior                                   │
└─────────────────────────────────────────────────────────────────┘
```

## Installation

```bash
npm install @durable-streams/client-conformance-tests
# or
pnpm add @durable-streams/client-conformance-tests
```

## CLI Usage

### Test the TypeScript Client

```bash
npx @durable-streams/client-conformance-tests --run ts
```

### Test a Custom Client Adapter

```bash
# Python client
npx @durable-streams/client-conformance-tests --run ./my-python-adapter.py

# Go client
npx @durable-streams/client-conformance-tests --run ./my-go-adapter

# Any executable
npx @durable-streams/client-conformance-tests --run /path/to/adapter
```

### CLI Options

```
Usage:
  npx @durable-streams/client-conformance-tests --run <adapter> [options]

Options:
  --suite <name>      Run only specific suite(s): producer, consumer, lifecycle
  --tag <name>        Run only tests with specific tag(s)
  --verbose           Show detailed output for each operation
  --fail-fast         Stop on first test failure
  --timeout <ms>      Timeout for each test in milliseconds (default: 30000)
  --port <port>       Port for reference server (default: random)
  --help, -h          Show help message
```

### Examples

```bash
# Test only producer functionality
npx @durable-streams/client-conformance-tests --run ts --suite producer

# Test only consumer functionality
npx @durable-streams/client-conformance-tests --run ./python-client --suite consumer

# Test core functionality with verbose output
npx @durable-streams/client-conformance-tests --run ts --tag core --verbose

# Stop on first failure
npx @durable-streams/client-conformance-tests --run ts --fail-fast
```

## Programmatic Usage

```typescript
import { runConformanceTests } from "@durable-streams/client-conformance-tests"

const summary = await runConformanceTests({
  clientAdapter: "ts", // or path to your adapter
  suites: ["producer", "consumer"],
  verbose: true,
})

console.log(`Passed: ${summary.passed}/${summary.total}`)
```

## Implementing a Client Adapter

A client adapter is an executable that communicates with the test runner via stdin/stdout using a JSON-line protocol.

### Protocol Overview

1. Test runner starts your adapter as a subprocess
2. Runner sends JSON commands to stdin (one per line)
3. Adapter executes commands using your client SDK
4. Adapter sends JSON results to stdout (one per line)

### Commands and Results

#### Init Command (first command, always sent)

```json
// Command (stdin)
{"type":"init","serverUrl":"http://localhost:3000"}

// Result (stdout)
{"type":"init","success":true,"clientName":"my-client","clientVersion":"1.0.0","features":{"batching":true,"sse":true,"longPoll":true}}
```

#### Create Command

```json
// Command
{"type":"create","path":"/my-stream","contentType":"text/plain"}

// Success Result
{"type":"create","success":true,"status":201,"offset":"0"}

// Error Result
{"type":"error","success":false,"commandType":"create","status":409,"errorCode":"CONFLICT","message":"Stream already exists"}
```

#### Append Command

```json
// Command
{"type":"append","path":"/my-stream","data":"Hello, World!","seq":1}

// Success Result
{"type":"append","success":true,"status":200,"offset":"13"}
```

#### Read Command

```json
// Command
{"type":"read","path":"/my-stream","offset":"0","live":"long-poll","timeoutMs":5000}

// Success Result
{"type":"read","success":true,"status":200,"chunks":[{"data":"Hello, World!","offset":"13"}],"offset":"13","upToDate":true}
```

#### Head Command

```json
// Command
{"type":"head","path":"/my-stream"}

// Success Result
{"type":"head","success":true,"status":200,"offset":"13","contentType":"text/plain"}
```

#### Delete Command

```json
// Command
{"type":"delete","path":"/my-stream"}

// Success Result
{"type":"delete","success":true,"status":200}
```

#### Shutdown Command

```json
// Command
{"type":"shutdown"}

// Result
{"type":"shutdown","success":true}
```

### Error Codes

Use these standard error codes in error results:

- `NETWORK_ERROR` - Network connection failed
- `TIMEOUT` - Operation timed out
- `CONFLICT` - Stream already exists (409)
- `NOT_FOUND` - Stream not found (404)
- `SEQUENCE_CONFLICT` - Sequence number conflict (409)
- `INVALID_OFFSET` - Invalid offset format
- `UNEXPECTED_STATUS` - Unexpected HTTP status
- `PARSE_ERROR` - Failed to parse response
- `INTERNAL_ERROR` - Client internal error
- `NOT_SUPPORTED` - Operation not supported

### Example: Python Adapter

```python
#!/usr/bin/env python3
import sys
import json
from durable_streams import DurableStream, DurableStreamError

def main():
    server_url = ""

    for line in sys.stdin:
        if not line.strip():
            continue

        command = json.loads(line)
        result = handle_command(command, server_url)

        if command["type"] == "init":
            server_url = command["serverUrl"]

        print(json.dumps(result), flush=True)

        if command["type"] == "shutdown":
            break

def handle_command(cmd, server_url):
    try:
        if cmd["type"] == "init":
            return {
                "type": "init",
                "success": True,
                "clientName": "durable-streams-python",
                "clientVersion": "0.1.0",
                "features": {"batching": False, "sse": True, "longPoll": True}
            }

        elif cmd["type"] == "create":
            url = f"{server_url}{cmd['path']}"
            stream = DurableStream.create(url, content_type=cmd.get("contentType"))
            return {"type": "create", "success": True, "status": 201}

        elif cmd["type"] == "append":
            url = f"{server_url}{cmd['path']}"
            stream = DurableStream(url)
            stream.append(cmd["data"], seq=cmd.get("seq"))
            return {"type": "append", "success": True, "status": 200}

        elif cmd["type"] == "read":
            url = f"{server_url}{cmd['path']}"
            # ... implement read logic
            return {"type": "read", "success": True, "status": 200, "chunks": [], "upToDate": True}

        elif cmd["type"] == "head":
            url = f"{server_url}{cmd['path']}"
            result = DurableStream.head(url)
            return {"type": "head", "success": True, "status": 200, "offset": result.offset}

        elif cmd["type"] == "delete":
            url = f"{server_url}{cmd['path']}"
            DurableStream.delete(url)
            return {"type": "delete", "success": True, "status": 200}

        elif cmd["type"] == "shutdown":
            return {"type": "shutdown", "success": True}

    except DurableStreamError as e:
        return {
            "type": "error",
            "success": False,
            "commandType": cmd["type"],
            "errorCode": map_error_code(e),
            "message": str(e)
        }

def map_error_code(error):
    # Map your client's error types to standard codes
    if error.status == 404:
        return "NOT_FOUND"
    elif error.status == 409:
        return "CONFLICT"
    return "INTERNAL_ERROR"

if __name__ == "__main__":
    main()
```

### Example: Go Adapter

```go
package main

import (
    "bufio"
    "encoding/json"
    "fmt"
    "os"

    durable "github.com/durable-streams/go-client"
)

type Command struct {
    Type      string `json:"type"`
    ServerURL string `json:"serverUrl,omitempty"`
    Path      string `json:"path,omitempty"`
    Data      string `json:"data,omitempty"`
    // ... other fields
}

type Result struct {
    Type        string `json:"type"`
    Success     bool   `json:"success"`
    Status      int    `json:"status,omitempty"`
    // ... other fields
}

func main() {
    scanner := bufio.NewScanner(os.Stdin)
    var serverURL string

    for scanner.Scan() {
        line := scanner.Text()
        if line == "" {
            continue
        }

        var cmd Command
        json.Unmarshal([]byte(line), &cmd)

        result := handleCommand(cmd, serverURL)

        if cmd.Type == "init" {
            serverURL = cmd.ServerURL
        }

        output, _ := json.Marshal(result)
        fmt.Println(string(output))

        if cmd.Type == "shutdown" {
            break
        }
    }
}

func handleCommand(cmd Command, serverURL string) Result {
    switch cmd.Type {
    case "init":
        return Result{
            Type:    "init",
            Success: true,
            // ... client info
        }
    case "create":
        // Use your Go client SDK
        return Result{Type: "create", Success: true, Status: 201}
    // ... handle other commands
    }
    return Result{Type: "error", Success: false}
}
```

## Test Coverage

The conformance test suite covers:

### Producer Tests

- **Stream Creation** - Create, idempotency, content types, TTL
- **Append Operations** - String/binary data, unicode, large payloads
- **Sequence Ordering** - Monotonic sequences, conflict detection
- **Batching** - Concurrent appends, order preservation
- **Error Handling** - 404s, 409s, network errors

### Consumer Tests

- **Catch-up Reads** - Empty/full streams, offset resumption
- **Long-Poll** - Waiting for data, timeouts
- **SSE Mode** - Event streaming, reconnection
- **Offset Handling** - Monotonicity, byte-exactness
- **Error Handling** - Invalid offsets, deleted streams

### Lifecycle Tests

- **Full Lifecycle** - Create, append, read, delete
- **Headers/Params** - Custom headers, auth tokens
- **Metadata** - HEAD requests, content types

## Adding New Test Cases

Test cases are defined in YAML files in the `test-cases/` directory:

```yaml
id: my-new-tests
name: My New Tests
description: Tests for new functionality
category: producer # or consumer, lifecycle
tags:
  - core
  - custom

tests:
  - id: my-test
    name: My test case
    description: What this test verifies
    setup:
      - action: create
        as: streamPath
    operations:
      - action: append
        path: ${streamPath}
        data: "test data"
        expect:
          status: 200
      - action: read
        path: ${streamPath}
        expect:
          data: "test data"
          upToDate: true
    cleanup:
      - action: delete
        path: ${streamPath}
```

## Protocol Types

For TypeScript/JavaScript adapters, you can import the protocol types:

```typescript
import {
  type TestCommand,
  type TestResult,
  parseCommand,
  serializeResult,
  ErrorCodes,
} from "@durable-streams/client-conformance-tests/protocol"
```

## License

Apache 2.0
