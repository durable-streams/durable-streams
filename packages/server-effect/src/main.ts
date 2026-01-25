/**
 * Entry point to start the Effect-based Durable Streams server.
 */
import { Effect } from "effect"
import { NodeRuntime } from "@effect/platform-node"
import { runServer } from "./server"
import { StreamStoreLive } from "./StreamStore"

const port = parseInt(process.env.PORT || "4437", 10)
const host = process.env.HOST || "127.0.0.1"

const program = runServer(port, host).pipe(
  Effect.provide(StreamStoreLive)
)

NodeRuntime.runMain(program)
