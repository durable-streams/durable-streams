/// <reference path="./.sst/platform/config.d.ts" />

/**
 * SST Configuration for Multiplayer Sudoku
 * 9,963 boxes across 123 puzzles - collaborative real-time Sudoku!
 */

export default $config({
  app(input) {
    return {
      name: `multiplayer-sudoku`,
      removal: input?.stage === `production` ? `retain` : `remove`,
      protect: [`production`].includes(input?.stage),
      home: `aws`,
      providers: {
        cloudflare: `5.42.0`,
        aws: {
          version: `6.66.2`,
        },
      },
    }
  },
  async run() {
    // Validate required environment variables
    if (!process.env.BETTER_AUTH_SECRET) {
      throw new Error(`BETTER_AUTH_SECRET environment variable is required`)
    }
    if (!process.env.DATABASE_URL) {
      throw new Error(`DATABASE_URL environment variable is required`)
    }

    // Apply migrations if database URL is available
    if (process.env.DATABASE_URL) {
      await applyDrizzleMigrations(process.env.DATABASE_URL)
    }

    const website = new sst.aws.TanStackStart(`multiplayer-sudoku`, {
      environment: {
        // Database
        DATABASE_URL: process.env.DATABASE_URL,

        // Electric
        ELECTRIC_URL: process.env.ELECTRIC_URL || `http://localhost:30000`,
        ELECTRIC_SOURCE_ID: process.env.ELECTRIC_SOURCE_ID || ``,
        ELECTRIC_SECRET: process.env.ELECTRIC_SECRET || ``,

        // Better Auth
        BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
        BETTER_AUTH_URL: process.env.BETTER_AUTH_URL || ``,
      },
    })

    return {
      url: website.url,
    }
  },
})

/**
 * Apply migrations using Drizzle Kit.
 */
async function applyDrizzleMigrations(dbUri: string) {
  const { execSync } = await import("node:child_process")
  console.log(`[sudoku] Applying Drizzle migrations`)
  execSync(`pnpm drizzle-kit migrate`, {
    env: {
      ...process.env,
      DATABASE_URL: dbUri,
    },
  })
}
