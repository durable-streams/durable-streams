/**
 * Effect System
 *
 * Implements the effect algebra from the formal specification:
 * - Effects combine sequentially with ⊙ (apply)
 * - Concurrent effects combine with merge
 * - Assignments mask previous effects
 * - Merge is associative, commutative, and idempotent (ACI)
 *
 * This module provides:
 * - Effect constructors (assign, increment, delete, custom)
 * - Apply operator (⊙)
 * - Merge operator for concurrent effects
 * - Utility functions for effect manipulation
 */

import { BOTTOM, isBottom } from "./types"
import type {
  AssignEffect,
  Bottom,
  CustomEffect,
  DeleteEffect,
  EffectOrBottom,
  IncrementEffect,
  Value,
} from "./types"

// =============================================================================
// Effect Constructors
// =============================================================================

/**
 * Create an assignment effect.
 * δ_assign_v is a constant function that yields v.
 *
 * @example
 * const effect = assign(42)
 * apply(effect, BOTTOM) // => 42
 * apply(effect, 100) // => 42
 */
export function assign(value: Value): AssignEffect {
  return { type: `assign`, value }
}

/**
 * Create an increment effect.
 * δ_incr_n adds n to the current value.
 * If applied to BOTTOM, returns BOTTOM (requires initial value).
 *
 * @example
 * const effect = increment(10)
 * apply(effect, 5) // => 15
 * apply(effect, BOTTOM) // => BOTTOM
 */
export function increment(delta: number): IncrementEffect {
  return { type: `increment`, delta }
}

/**
 * Create a delete effect.
 * Removes the key by setting its value to BOTTOM.
 *
 * @example
 * const effect = del()
 * apply(effect, 42) // => BOTTOM
 */
export function del(): DeleteEffect {
  return { type: `delete` }
}

/**
 * Create a custom effect with user-defined apply and merge functions.
 * Enables rich CRDT-like data types.
 *
 * @example
 * // A set-add effect
 * const addToSet = (item: string) => custom(
 *   "set-add",
 *   item,
 *   (value) => {
 *     const set = new Set(value as string[] ?? [])
 *     set.add(item)
 *     return [...set]
 *   },
 *   (other) => addToSet(other.payload) // merge adds both
 * )
 */
export function custom<T>(
  name: string,
  payload: T,
  applyFn: (value: Value | Bottom) => Value | Bottom,
  mergeFn: (other: CustomEffect<T>) => CustomEffect<T>
): CustomEffect<T> {
  const effect: CustomEffect<T> = {
    type: `custom`,
    name,
    payload,
    apply: applyFn,
    merge: mergeFn,
  }
  return effect
}

// =============================================================================
// Type Guards
// =============================================================================

/**
 * Check if an effect is an assignment.
 * Assignments are special because they mask all previous effects.
 */
export function isAssignment(effect: EffectOrBottom): effect is AssignEffect {
  return !isBottom(effect) && effect.type === `assign`
}

/**
 * Check if an effect is an increment.
 */
export function isIncrement(effect: EffectOrBottom): effect is IncrementEffect {
  return !isBottom(effect) && effect.type === `increment`
}

/**
 * Check if an effect is a delete.
 */
export function isDelete(effect: EffectOrBottom): effect is DeleteEffect {
  return !isBottom(effect) && effect.type === `delete`
}

/**
 * Check if an effect is custom.
 */
export function isCustom(effect: EffectOrBottom): effect is CustomEffect {
  return !isBottom(effect) && effect.type === `custom`
}

// =============================================================================
// Apply Operator (⊙)
// =============================================================================

/**
 * Apply an effect to a value.
 * This is the core ⊙ operator from the specification.
 *
 * Rules:
 * - (⊥ ⊙ δ) = (δ ⊙ ⊥) = δ  (BOTTOM is identity for non-applicable effects)
 * - Assignments are constant functions
 * - Increments add to numeric values
 * - Deletes return BOTTOM
 *
 * @param effect The effect to apply (or BOTTOM)
 * @param value The value to apply the effect to (or BOTTOM)
 * @returns The resulting value (or BOTTOM)
 */
export function applyEffect(
  effect: EffectOrBottom,
  value: Value | Bottom
): Value | Bottom {
  // ⊥ ⊙ v = v (no effect)
  if (isBottom(effect)) {
    return value
  }

  switch (effect.type) {
    case `assign`:
      // Assignment is a constant function - always returns the assigned value
      return effect.value

    case `increment`:
      // Increment adds delta to numeric value
      if (isBottom(value)) {
        // Incrementing BOTTOM - treat as incrementing 0
        // This is necessary for concurrent increments where the base value
        // (from a preceding assignment) is not in the maximal version set
        return effect.delta
      }
      if (typeof value !== `number`) {
        throw new Error(`Cannot increment non-numeric value: ${typeof value}`)
      }
      return value + effect.delta

    case `delete`:
      // Delete sets to BOTTOM
      return BOTTOM

    case `custom`:
      // Custom effects define their own apply
      return effect.apply(value)
  }
}

/**
 * Apply an effect to BOTTOM and get the resulting value.
 * Useful for evaluating a final effect sequence.
 *
 * @param effect The effect to evaluate
 * @returns The value, or throws if result is BOTTOM
 */
export function effectToValue(effect: EffectOrBottom): Value {
  const result = applyEffect(effect, BOTTOM)
  if (isBottom(result)) {
    throw new Error(`Effect applied to BOTTOM resulted in BOTTOM`)
  }
  return result
}

// =============================================================================
// Effect Composition (Sequential)
// =============================================================================

/**
 * Compose two effects sequentially.
 * (δ1 ⊙ δ2) applied to v equals δ2 applied to (δ1 applied to v).
 *
 * Important: Assignments absorb previous effects.
 * ∀δ, (δ ⊙ δ_assign_x) = δ_assign_x
 *
 * @param first The first effect (applied first)
 * @param second The second effect (applied second)
 * @returns The composed effect
 */
export function composeEffects(
  first: EffectOrBottom,
  second: EffectOrBottom
): EffectOrBottom {
  // ⊥ ⊙ δ = δ
  if (isBottom(first)) {
    return second
  }

  // δ ⊙ ⊥ = δ
  if (isBottom(second)) {
    return first
  }

  // δ ⊙ δ_assign_x = δ_assign_x (assignment absorbs)
  if (isAssignment(second)) {
    return second
  }

  // δ_assign_x ⊙ δ = δ_assign_(δ(x)) (proper sequence to assignment)
  if (isAssignment(first)) {
    const result = applyEffect(second, first.value)
    if (isBottom(result)) {
      return del()
    }
    return assign(result)
  }

  // δ_incr_a ⊙ δ_incr_b = δ_incr_(a+b)
  if (isIncrement(first) && isIncrement(second)) {
    return increment(first.delta + second.delta)
  }

  // δ_delete ⊙ δ = depends on δ
  if (isDelete(first)) {
    // Delete followed by assignment: the assignment wins
    if (isAssignment(second)) {
      return second
    }
    // Delete followed by increment: still deleted (BOTTOM + n = BOTTOM)
    if (isIncrement(second)) {
      return del()
    }
    // Delete followed by delete: still delete
    if (isDelete(second)) {
      return del()
    }
  }

  // Custom effect composition
  if (isCustom(first) || isCustom(second)) {
    // Create a composed custom effect
    return custom(
      `composed(${isCustom(first) ? first.name : first.type},${isCustom(second) ? second.name : second.type})`,
      { first, second },
      (value) => applyEffect(second, applyEffect(first, value)),
      (other) =>
        composeEffects(composeEffects(first, second), other) as CustomEffect
    )
  }

  // Fallback: create a composed effect
  return custom(
    `composed(${first.type},${second.type})`,
    { first, second },
    (value) => applyEffect(second, applyEffect(first, value)),
    (other) =>
      composeEffects(composeEffects(first, second), other) as CustomEffect
  )
}

/**
 * Compose a sequence of effects.
 * Applies effects left-to-right: [δ1, δ2, δ3] = (δ1 ⊙ δ2) ⊙ δ3
 *
 * @param effects Array of effects to compose
 * @returns The composed effect (or BOTTOM if empty)
 */
export function composeEffectSequence(
  effects: Array<EffectOrBottom>
): EffectOrBottom {
  return effects.reduce(
    (acc, effect) => composeEffects(acc, effect),
    BOTTOM as EffectOrBottom
  )
}

// =============================================================================
// Merge Operator (Concurrent Effects)
// =============================================================================

/**
 * Merge two concurrent effects.
 * Merge is associative, commutative, and idempotent (ACI).
 *
 * For increments: merge(δ_incr_a, δ_incr_b) = δ_incr_(a+b)
 * For assignments: last-writer-wins (by some deterministic order)
 *
 * @param a First effect
 * @param b Second effect
 * @returns The merged effect
 */
export function mergeEffects(
  a: EffectOrBottom,
  b: EffectOrBottom
): EffectOrBottom {
  // merge({}) = ⊥
  // merge({δ}) = δ
  if (isBottom(a)) return b
  if (isBottom(b)) return a

  // Same type merges
  if (a.type === b.type) {
    switch (a.type) {
      case `increment`: {
        const bInc = b as IncrementEffect
        // Increments add
        return increment(a.delta + bInc.delta)
      }

      case `assign`: {
        const bAssign = b as AssignEffect
        // Last-writer-wins: use deterministic comparison
        // In practice, timestamps would determine this
        // Here we use JSON comparison for determinism
        const aJson = JSON.stringify(a.value)
        const bJson = JSON.stringify(bAssign.value)
        return aJson >= bJson ? a : bAssign
      }

      case `delete`:
        // Both delete: still delete
        return del()

      case `custom`: {
        const aCustom = a as CustomEffect
        const bCustom = b as CustomEffect
        if (aCustom.name === bCustom.name) {
          return aCustom.merge(bCustom)
        }
        // Different custom types: create combined effect
        throw new Error(
          `Cannot merge different custom effect types: ${aCustom.name} vs ${bCustom.name}`
        )
      }
    }
  }

  // Different types: apply precedence rules
  // Delete has lowest precedence (assignment or increment wins)
  if (isDelete(a)) return b
  if (isDelete(b)) return a

  // Assignment vs increment: assignment wins (it sets the final value)
  if (isAssignment(a) && isIncrement(b)) {
    // Apply increment to assignment value
    return assign(applyEffect(b, a.value))
  }
  if (isIncrement(a) && isAssignment(b)) {
    // Apply increment to assignment value
    return assign(applyEffect(a, b.value))
  }

  // Fallback for mixed types
  throw new Error(`Cannot merge effects of types: ${a.type} and ${b.type}`)
}

/**
 * Merge a set of concurrent effects.
 * merge({δ1, δ2, ..., δn}) combines all effects.
 *
 * @param effects Set or array of effects to merge
 * @returns The merged effect (or BOTTOM if empty)
 */
export function mergeEffectSet(
  effects: Iterable<EffectOrBottom>
): EffectOrBottom {
  let result: EffectOrBottom = BOTTOM
  for (const effect of effects) {
    result = mergeEffects(result, effect)
  }
  return result
}

// =============================================================================
// Effect Utilities
// =============================================================================

/**
 * Check if an effect sequence is proper (starts with an assignment).
 * A proper sequence can be evaluated to a value.
 */
export function isProperSequence(effects: Array<EffectOrBottom>): boolean {
  if (effects.length === 0) return false
  const first = effects[0]
  return !isBottom(first) && isAssignment(first)
}

/**
 * Find the last assignment in an effect sequence.
 * Effects before the last assignment can be ignored.
 */
export function findLastAssignment(
  effects: Array<EffectOrBottom>
): { index: number; effect: AssignEffect } | undefined {
  for (let i = effects.length - 1; i >= 0; i--) {
    const effect = effects[i]
    if (effect && isAssignment(effect)) {
      return { index: i, effect }
    }
  }
  return undefined
}

/**
 * Compact an effect sequence by removing effects before the last assignment.
 * This optimization is used in stores to reduce storage.
 */
export function compactEffectSequence(
  effects: Array<EffectOrBottom>
): Array<EffectOrBottom> {
  const lastAssign = findLastAssignment(effects)
  if (lastAssign) {
    // Keep only from last assignment onwards
    return effects.slice(lastAssign.index)
  }
  return effects
}

/**
 * Evaluate an effect sequence to a value.
 * The sequence must be proper (start with assignment).
 *
 * @throws If sequence is not proper
 */
export function evaluateEffectSequence(effects: Array<EffectOrBottom>): Value {
  if (!isProperSequence(effects)) {
    throw new Error(`Cannot evaluate non-proper effect sequence`)
  }

  const compacted = compactEffectSequence(effects)
  const composed = composeEffectSequence(compacted)
  return effectToValue(composed)
}

// =============================================================================
// Effect Comparison
// =============================================================================

/**
 * Check if two effects are structurally equal.
 */
export function effectsEqual(a: EffectOrBottom, b: EffectOrBottom): boolean {
  if (isBottom(a) && isBottom(b)) return true
  if (isBottom(a) || isBottom(b)) return false

  if (a.type !== b.type) return false

  switch (a.type) {
    case `assign`:
      return (
        JSON.stringify(a.value) === JSON.stringify((b as AssignEffect).value)
      )
    case `increment`:
      return a.delta === (b as IncrementEffect).delta
    case `delete`:
      return true
    case `custom`:
      return (
        a.name === (b as CustomEffect).name &&
        JSON.stringify(a.payload) ===
          JSON.stringify((b as CustomEffect).payload)
      )
  }
}
