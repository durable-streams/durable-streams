# Claude Code Web

A browser-based interface for running Claude Code against GitHub repositories. Built with TanStack Start, xterm.js, and Durable Streams for reliable, resumable terminal sessions.

## Features

- **Browser-based terminal** - Full xterm.js terminal with Claude Code
- **Persistent sessions** - Terminal output saved via Durable Streams, resume from any device
- **GitHub integration** - Select and clone any repository you have access to
- **Container lifecycle** - Automatic spin-up on input, spin-down on idle
- **Sub-instance spawning** - Claude Code can spawn parallel instances for concurrent tasks
- **Direct shell access** - SSH-like access to running containers for debugging

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Browser Client                                  │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐              │
│  │   xterm.js      │  │  Session List   │  │  Repo Selector  │              │
│  │   Terminal      │  │    Sidebar      │  │    (GitHub)     │              │
│  └────────┬────────┘  └────────┬────────┘  └────────┬────────┘              │
└───────────┼────────────────────┼────────────────────┼────────────────────────┘
            │                    │                    │
            ▼                    ▼                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         TanStack Start Application                           │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐              │
│  │  Session API    │  │  GitHub API     │  │  Modal API      │              │
│  │  /api/sessions  │  │  /api/repos     │  │  /api/sandboxes │              │
│  └────────┬────────┘  └────────┬────────┘  └────────┬────────┘              │
└───────────┼────────────────────┼────────────────────┼────────────────────────┘
            │                    │                    │
            ▼                    ▼                    ▼
┌───────────────────────┐  ┌───────────────┐  ┌────────────────────────────────┐
│   Durable Streams     │  │  GitHub API   │  │         Modal.com              │
│   Server              │  │               │  │  ┌────────────────────────┐    │
│  ┌─────────────────┐  │  │  - List repos │  │  │    Modal Sandbox       │    │
│  │ /input/{id}     │──┼──┼───────────────┼──┼─▶│  ┌──────────────────┐  │    │
│  │ (user input)    │  │  │  - Clone URL  │  │  │  │   Claude Code    │  │    │
│  └─────────────────┘  │  │               │  │  │  │   CLI Process    │  │    │
│  ┌─────────────────┐  │  └───────────────┘  │  │  └──────────────────┘  │    │
│  │ /output/{id}    │◀─┼─────────────────────┼──┼───────────────────────│    │
│  │ (PTY output)    │  │                     │  │                        │    │
│  └─────────────────┘  │                     │  └────────────────────────┘    │
└───────────────────────┘                     └────────────────────────────────┘
```

## Prerequisites

- Node.js 22+
- pnpm 10+
- Docker (for building the sandbox image)
- Modal.com account (for cloud deployment)
- GitHub personal access token
- Anthropic API key

## Quick Start

### 1. Install dependencies

```bash
cd examples/claude-code-web
pnpm install
```

### 2. Set up environment variables

Create a `.env` file:

```bash
cp .env.example .env
```

Edit `.env` with your credentials:

```env
# Required
ANTHROPIC_API_KEY=sk-ant-...
GITHUB_TOKEN=ghp_...

# Durable Streams server URL
DURABLE_STREAMS_URL=http://localhost:4437

# Optional: Modal sidecar URL (for container management)
MODAL_SIDECAR_URL=http://localhost:8080

# Optional: Session API token for hook authentication
SESSION_API_TOKEN=your-secret-token

# Optional: Idle timeout in milliseconds (default: 5 minutes)
IDLE_TIMEOUT_MS=300000
```

### 3. Start the Durable Streams server

In a separate terminal:

```bash
# From the monorepo root
pnpm start:dev
```

### 4. Build the Docker image

```bash
cd docker
docker build -t claude-code-web-sandbox -f Dockerfile .
```

### 5. Start the development server

```bash
pnpm dev
```

Open http://localhost:3000 in your browser.

## Deployment

### Docker Compose (Local Development)

A `docker-compose.yml` is provided for local development:

```bash
docker-compose up
```

This starts:
- Durable Streams server on port 4437
- Claude Code Web app on port 3000
- Modal sidecar (if configured)

### Modal.com (Production)

For production deployment with Modal.com:

1. Install Modal CLI: `pip install modal`
2. Configure: `modal token new`
3. Deploy: `modal deploy`

See `modal/` directory for Modal configuration files.

## Container Lifecycle

The system manages container state through these transitions:

```
STOPPED → STARTING → RUNNING ⇄ IDLE → STOPPED
```

- **STOPPED**: No container running
- **STARTING**: Creating Modal sandbox
- **RUNNING**: Claude Code active, processing input
- **IDLE**: Claude finished responding, idle timer running (5 min default)

Claude Code hooks trigger state changes:
- `Stop` hook → Start idle timer
- `SessionEnd` hook → Immediate termination
- User input during IDLE → Resume to RUNNING

## Sub-Instance Spawning

Claude Code can spawn independent sub-instances for parallel work:

```bash
# From within Claude Code session
spawn-instance --task "Fix authentication bug" --context "JWT validation failing"
```

Each sub-instance:
- Works on its own auto-generated branch
- Has its own Durable Streams for output capture
- Operates completely independently (fire-and-forget)

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | Yes | - | Anthropic API key for Claude |
| `GITHUB_TOKEN` | Yes | - | GitHub PAT with repo access |
| `DURABLE_STREAMS_URL` | No | `http://localhost:4437` | Durable Streams server URL |
| `MODAL_SIDECAR_URL` | No | `http://localhost:8080` | Modal sidecar service URL |
| `SESSION_API_TOKEN` | No | `dev-token` | Token for hook authentication |
| `IDLE_TIMEOUT_MS` | No | `300000` | Idle timeout in ms (5 min) |

### Claude Code Settings

The container includes Claude Code hooks in `/etc/claude-code/settings.json`:

- **Stop hook**: Notifies API when Claude finishes responding
- **SessionEnd hook**: Triggers immediate container termination
- **SessionStart hook**: Logs session initialization

### Sandbox Tools

The Docker image includes:

- **Editors**: Neovim 0.11 with LSP, Treesitter, Telescope
- **CLI tools**: ripgrep, fd, fzf, jq, bat
- **Version control**: Git, GitHub CLI (gh)
- **Languages**: Node.js 22, Python 3, pnpm
- **Utilities**: tmux, htop, curl, wget

## Development

### Project Structure

```
examples/claude-code-web/
├── src/
│   ├── api/              # Server functions
│   │   ├── sessions.ts   # Session management
│   │   └── repos.ts      # GitHub integration
│   ├── components/       # React components
│   │   ├── Terminal.tsx  # xterm.js wrapper
│   │   ├── SessionList.tsx
│   │   ├── RepoSelector.tsx
│   │   └── DirectAccess.tsx
│   ├── lib/              # Utilities
│   │   ├── types.ts      # Type definitions
│   │   ├── terminal.ts   # Terminal creation
│   │   ├── modal.ts      # Modal SDK wrapper
│   │   ├── github.ts     # GitHub client
│   │   ├── durable-streams.ts
│   │   ├── session-store.ts
│   │   └── env.ts        # Environment config
│   ├── routes/           # TanStack Start routes
│   │   ├── __root.tsx
│   │   ├── index.tsx
│   │   └── session.$sessionId.tsx
│   └── styles/           # CSS
│       └── main.css
├── docker/               # Docker configuration
│   ├── Dockerfile
│   ├── nvim-init.lua
│   ├── claude-settings.json
│   ├── spawn-instance
│   ├── hooks/
│   │   ├── on-stop.sh
│   │   ├── on-session-end.sh
│   │   └── on-session-start.sh
│   └── skills/
│       └── spawn-instances.md
└── public/               # Static assets
```

### Scripts

```bash
pnpm dev        # Start development server
pnpm build      # Build for production
pnpm start      # Start production server
pnpm typecheck  # Type check
```

## License

MIT
