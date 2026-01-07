package main

import (
	"fmt"
	"os"

	caddycmd "github.com/caddyserver/caddy/v2/cmd"

	// Import standard modules
	_ "github.com/caddyserver/caddy/v2/modules/standard"

	// Import our durable streams module
	_ "github.com/durable-streams/durable-streams/packages/caddy-plugin"
)

const defaultCaddyfile = `{
	admin off
	auto_https off
}

:4437 {
	route /v1/stream/* {
		durable_streams
	}
}
`

func main() {
	// Check for dev mode
	if len(os.Args) > 1 && os.Args[1] == "dev" {
		runDevMode()
		return
	}

	caddycmd.Main()
}

func runDevMode() {
	fmt.Println("🚀 Starting Durable Streams development server...")
	fmt.Println("📍 Server running at: http://localhost:4437")
	fmt.Println("📝 Endpoint: http://localhost:4437/v1/stream/*")
	fmt.Println("💾 Storage: in-memory (no persistence)")
	fmt.Println()
	fmt.Println("Press Ctrl+C to stop")
	fmt.Println()

	// Write default Caddyfile to temp location
	tmpfile, err := os.CreateTemp("", "Caddyfile.*")
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error creating temp Caddyfile: %v\n", err)
		os.Exit(1)
	}
	defer os.Remove(tmpfile.Name())

	if _, err := tmpfile.Write([]byte(defaultCaddyfile)); err != nil {
		fmt.Fprintf(os.Stderr, "Error writing temp Caddyfile: %v\n", err)
		os.Exit(1)
	}
	if err := tmpfile.Close(); err != nil {
		fmt.Fprintf(os.Stderr, "Error closing temp Caddyfile: %v\n", err)
		os.Exit(1)
	}

	// Replace args with 'run --config <tempfile>'
	os.Args = []string{os.Args[0], "run", "--config", tmpfile.Name()}

	// Run Caddy
	caddycmd.Main()
}
