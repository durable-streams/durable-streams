# Massive Multiplayer Sudoku

A real-time collaborative sudoku game with **9,963 boxes** across **123 puzzles**. Built with [TanStack Start](https://tanstack.com/start/latest), [TanStack DB](https://tanstack.com/db/latest), and [Electric SQL](https://electric-sql.com/) for instant multiplayer synchronization.

## One-Click Deploy

[![Open in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz.svg)](https://stackblitz.com/github/durable-streams/durable-streams/tree/main/examples/multiplayer-sudoku)

**Or deploy with Electric Cloud:**

```bash
npx @electric-sql/start multiplayer-sudoku
```

## Features

- **9,963 playable cells** organized as 123 standard 9x9 sudoku puzzles
- **Real-time multiplayer** - see other players' moves instantly
- **Player colors** - each player gets a unique color for their contributions
- **Leaderboard** - track who's solving the most cells
- **Responsive design** - works on desktop and mobile

## Architecture

```
┌─────────────────────────────────────────┐
│           React Frontend                │
│  TanStack Router + TanStack DB         │
│  Live queries with sub-ms updates       │
└─────────────────┬───────────────────────┘
                  │
                  ▼ HTTP/SSE
┌─────────────────────────────────────────┐
│         TanStack Start Server           │
│   tRPC mutations + Electric proxy       │
└─────────────────┬───────────────────────┘
                  │
          ┌───────┴───────┐
          ▼               ▼
┌──────────────┐  ┌──────────────────┐
│   Electric   │◄─│    PostgreSQL    │
│   Sync       │  │   (9963 cells)   │
└──────────────┘  └──────────────────┘
```

## Quick Start (Local Development)

### Prerequisites

- [Docker](https://www.docker.com) - for Postgres + Electric
- [Node.js 20+](https://nodejs.org) with [pnpm](https://pnpm.io)
- [Caddy](https://caddyserver.com) (optional, for HTTP/2 in dev)

### Setup

```bash
# Clone and install
cd multiplayer-sudoku
pnpm install

# Copy environment file
cp .env.example .env

# Start Postgres and Electric
pnpm backend:up

# Run database migrations
pnpm migrate

# Start development server
pnpm dev
```

Open http://localhost:5173 (or https://localhost:3443 with Caddy)

## Deployment

### Option 1: Electric Cloud (Recommended)

1. **Provision Electric Cloud**

   ```bash
   npx @electric-sql/start my-sudoku
   ```

2. **Set environment variables**

   ```bash
   DATABASE_URL=<your-postgres-url>
   ELECTRIC_URL=<electric-cloud-url>
   ELECTRIC_SOURCE_ID=<source-id>
   ELECTRIC_SECRET=<source-secret>
   BETTER_AUTH_SECRET=<32-char-secret>
   ```

3. **Deploy to your preferred platform**
   - Vercel: `vercel deploy`
   - SST/AWS: `pnpm sst deploy --stage production`
   - Render/Railway: Connect your repo

### Option 2: Self-Hosted

Use the `docker-compose.yaml` as a starting point:

```bash
docker compose up -d
pnpm migrate
pnpm build
pnpm start
```

## Game Mechanics

### Puzzle Generation

The game generates 123 unique sudoku puzzles using:

1. **Backtracking algorithm** - Creates a complete valid 9x9 solution
2. **Randomization** - Shuffles the number placement for variety
3. **Difficulty variation** - Each puzzle has 35-55% of cells removed
4. **Pre-filled cells** - Cannot be modified (shown in darker background)

### Multiplayer Sync

- Each cell is a row in PostgreSQL
- Electric SQL streams changes to all clients via SSE
- Optimistic updates for instant feedback
- Conflict resolution: last-write-wins

### Leaderboard

Players earn points by filling cells. Each filled cell:

- Gets marked with the player's unique color
- Shows the player's name on hover
- Counts towards their leaderboard score

## Project Structure

```
multiplayer-sudoku/
├── src/
│   ├── db/
│   │   ├── schema.ts         # Database schema (cells, stats)
│   │   └── out/              # Drizzle migrations
│   ├── lib/
│   │   ├── collections.ts    # Electric collections
│   │   ├── sudoku-generator.ts # Puzzle generation
│   │   └── trpc/             # API routes
│   └── routes/
│       ├── index.tsx         # Main game UI
│       ├── login.tsx         # Authentication
│       └── api/              # Electric proxy endpoints
├── docker-compose.yaml       # Local Postgres + Electric
└── package.json
```

## Tech Stack

| Technology     | Purpose                      |
| -------------- | ---------------------------- |
| TanStack Start | Full-stack React framework   |
| TanStack DB    | Client-side data management  |
| Electric SQL   | Real-time Postgres sync      |
| tRPC           | Type-safe API layer          |
| Drizzle ORM    | Database schema & migrations |
| Better Auth    | Simple authentication        |
| Tailwind CSS   | Styling                      |

## Scripts

| Command                 | Description              |
| ----------------------- | ------------------------ |
| `pnpm dev`              | Start development server |
| `pnpm build`            | Build for production     |
| `pnpm start`            | Start production server  |
| `pnpm backend:up`       | Start Docker services    |
| `pnpm backend:down`     | Stop Docker services     |
| `pnpm migrate`          | Run database migrations  |
| `pnpm migrate:generate` | Generate new migration   |

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run `pnpm lint` and `pnpm format`
5. Submit a pull request

## License

MIT
