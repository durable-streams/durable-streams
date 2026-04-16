import { spawn } from "node:child_process"

const pnpmCmd = process.platform === `win32` ? `pnpm.cmd` : `pnpm`

const streams = spawn(
  pnpmCmd,
  [`--filter`, `@durable-streams/cli`, `start:dev`],
  {
    stdio: `inherit`,
  }
)

const appEnv = {
  ...process.env,
  DURABLE_STREAMS_URL:
    process.env.DURABLE_STREAMS_URL ?? `http://localhost:4437`,
}

const app = spawn(pnpmCmd, [`run`, `dev:app`], {
  stdio: `inherit`,
  env: appEnv,
})

let shuttingDown = false
function shutdown(signal: NodeJS.Signals | `EXIT`): void {
  if (shuttingDown) return
  shuttingDown = true

  if (signal !== `EXIT`) {
    streams.kill(signal)
    app.kill(signal)
  } else {
    streams.kill()
    app.kill()
  }
}

process.on(`SIGINT`, () => shutdown(`SIGINT`))
process.on(`SIGTERM`, () => shutdown(`SIGTERM`))
process.on(`exit`, () => shutdown(`EXIT`))

streams.on(`exit`, (code) => {
  if (shuttingDown) return
  shutdown(`SIGTERM`)
  process.exit(code ?? 0)
})

app.on(`exit`, (code) => {
  if (shuttingDown) return
  shutdown(`SIGTERM`)
  process.exit(code ?? 0)
})
