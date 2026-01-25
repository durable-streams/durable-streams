/**
 * Configuration service for the durable streams server.
 */
import { Config, Context, Duration, Effect, Layer } from "effect"

/**
 * Server configuration interface for Effect-based runtime configuration.
 */
export interface ServerConfigShape {
  readonly longPollTimeout: Duration.Duration
  readonly cursorIntervalSeconds: number
  readonly cursorEpoch: Date
  readonly producerStateTtl: Duration.Duration
}

/**
 * Server configuration service tag for Effect dependency injection.
 */
export class ServerConfigService extends Context.Tag(
  `@durable-streams/server-effect/ServerConfigService`
)<ServerConfigService, ServerConfigShape>() {
  /**
   * Default configuration layer using environment variables with fallbacks.
   */
  static readonly Default = Layer.effect(
    ServerConfigService,
    Effect.gen(function* () {
      const longPollTimeout = yield* Config.duration(`LONG_POLL_TIMEOUT`).pipe(
        Config.withDefault(Duration.seconds(30))
      )
      const cursorIntervalSeconds = yield* Config.number(
        `CURSOR_INTERVAL_SECONDS`
      )
        .pipe()
        .pipe(Config.withDefault(20))
      const cursorEpochStr = yield* Config.string(`CURSOR_EPOCH`).pipe(
        Config.withDefault(`2024-10-09T00:00:00.000Z`)
      )
      const producerStateTtl = yield* Config.duration(`PRODUCER_STATE_TTL`)
        .pipe()
        .pipe(Config.withDefault(Duration.days(7)))

      return {
        longPollTimeout,
        cursorIntervalSeconds,
        cursorEpoch: new Date(cursorEpochStr),
        producerStateTtl,
      }
    })
  )

  /**
   * Layer with custom configuration values.
   */
  static readonly make = (config: Partial<ServerConfigShape>) =>
    Layer.succeed(ServerConfigService, {
      longPollTimeout: config.longPollTimeout ?? Duration.seconds(30),
      cursorIntervalSeconds: config.cursorIntervalSeconds ?? 20,
      cursorEpoch: config.cursorEpoch ?? new Date(`2024-10-09T00:00:00.000Z`),
      producerStateTtl: config.producerStateTtl ?? Duration.days(7),
    })
}
