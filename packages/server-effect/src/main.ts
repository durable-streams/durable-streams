/**
 * Entry point to start the Effect-based Durable Streams server.
 */
import { Effect } from "effect"
import { NodeRuntime } from "@effect/platform-node"
import { runServer } from "./server"
import { StreamStoreLive } from "./StreamStore"
import { ServerConfigService } from "./Config"

const port = parseInt(process.env.PORT || `4437`, 10)
const host = process.env.HOST || `127.0.0.1`

const program = Effect.gen(function* () {
  // Read config from environment
  const config = yield* ServerConfigService
  // Run server with config
  yield* runServer(port, host, config)
}).pipe(
  Effect.provide(StreamStoreLive),
  Effect.provide(ServerConfigService.Default)
)

NodeRuntime.runMain(program)
