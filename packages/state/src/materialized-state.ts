import type { ChangeMessage } from "./types"

/**
 * MaterializedState maintains an in-memory view of state from change events.
 *
 * It organizes data by type, where each type contains a map of key -> value.
 * This supports multi-type streams where different entity types can coexist.
 */
export class MaterializedState {
  private data: Map<string, Map<string, unknown>>

  constructor() {
    this.data = new Map()
  }

  /**
   * Apply a single change event to update the materialized state
   */
  apply(event: ChangeMessage): void {
    const { type, key, value, headers } = event

    // Get or create the type map
    let typeMap = this.data.get(type)
    if (!typeMap) {
      typeMap = new Map()
      this.data.set(type, typeMap)
    }

    // Apply the operation
    switch (headers.operation) {
      case `insert`:
        typeMap.set(key, value)
        break
      case `update`:
        typeMap.set(key, value)
        break
      case `delete`:
        typeMap.delete(key)
        break
    }
  }

  /**
   * Apply a batch of change events
   */
  applyBatch(events: Array<ChangeMessage>): void {
    for (const event of events) {
      this.apply(event)
    }
  }

  /**
   * Get a specific value by type and key
   */
  get<T = unknown>(type: string, key: string): T | undefined {
    const typeMap = this.data.get(type)
    if (!typeMap) {
      return undefined
    }
    return typeMap.get(key) as T | undefined
  }

  /**
   * Get all entries for a specific type
   */
  getType(type: string): Map<string, unknown> {
    return this.data.get(type) || new Map()
  }

  /**
   * Clear all state
   */
  clear(): void {
    this.data.clear()
  }

  /**
   * Get the number of types in the state
   */
  get typeCount(): number {
    return this.data.size
  }

  /**
   * Get all type names
   */
  get types(): Array<string> {
    return Array.from(this.data.keys())
  }
}
