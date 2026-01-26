/**
 * Dynamic header and parameter resolution utilities.
 */
import { Effect } from "effect"
import type { DynamicValue, HeadersRecord, ParamsRecord } from "../types.js"

/**
 * Resolve a dynamic value to its final string form.
 */
export const resolveDynamicValue = Effect.fn(`resolveDynamicValue`)(
  (value: DynamicValue<string> | undefined): Effect.Effect<string | undefined> => {
    if (value === undefined) {
      return Effect.succeed(undefined)
    }

    if (typeof value === `string`) {
      return Effect.succeed(value)
    }

    if (typeof value === `function`) {
      const result = value()
      if (Effect.isEffect(result)) {
        return result as Effect.Effect<string>
      }
      return Effect.succeed(result as string)
    }

    return Effect.succeed(undefined)
  }
)

/**
 * Resolve all headers to static values.
 */
export const resolveHeaders = Effect.fn(`resolveHeaders`)(
  (headers: HeadersRecord | undefined): Effect.Effect<Record<string, string>> =>
    Effect.gen(function* () {
      if (!headers) {
        return {}
      }

      const result: Record<string, string> = {}

      for (const [key, value] of Object.entries(headers)) {
        const resolved = yield* resolveDynamicValue(value)
        if (resolved !== undefined) {
          result[key] = resolved
        }
      }

      return result
    })
)

/**
 * Resolve all parameters to static values.
 */
export const resolveParams = Effect.fn(`resolveParams`)(
  (params: ParamsRecord | undefined): Effect.Effect<Record<string, string>> =>
    Effect.gen(function* () {
      if (!params) {
        return {}
      }

      const result: Record<string, string> = {}

      for (const [key, value] of Object.entries(params)) {
        const resolved = yield* resolveDynamicValue(value)
        if (resolved !== undefined) {
          result[key] = resolved
        }
      }

      return result
    })
)

/**
 * Merge two header records, with override taking precedence.
 */
export const mergeHeaders = (
  base: HeadersRecord | undefined,
  override: HeadersRecord | undefined
): HeadersRecord => ({
  ...base,
  ...override,
})

/**
 * Merge two param records, with override taking precedence.
 */
export const mergeParams = (
  base: ParamsRecord | undefined,
  override: ParamsRecord | undefined
): ParamsRecord => ({
  ...base,
  ...override,
})
