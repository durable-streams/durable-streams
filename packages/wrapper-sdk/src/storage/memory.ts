/**
 * In-memory storage implementation for development and testing.
 */

import type { Storage } from "../types"

/**
 * In-memory storage implementation for development and testing.
 *
 * Data is lost when the process restarts. Use this for:
 * - Local development
 * - Testing
 * - Ephemeral applications
 *
 * For production, implement a persistent Storage interface
 * (e.g., Redis, DynamoDB, Cloudflare Durable Objects).
 *
 * @example
 * ```typescript
 * const storage = new InMemoryStorage()
 *
 * await storage.set('user:123', { name: 'Alice' })
 * const user = await storage.get<{ name: string }>('user:123')
 * console.log(user?.name) // 'Alice'
 *
 * // List all user keys
 * for await (const [key, value] of storage.list('user:')) {
 *   console.log(key, value)
 * }
 * ```
 */
export class InMemoryStorage implements Storage {
  readonly #data = new Map<string, unknown>()

  /**
   * Get a value by key.
   *
   * @param key - The storage key
   * @returns The value or undefined if not found
   */
  async get<T = unknown>(key: string): Promise<T | undefined> {
    return this.#data.get(key) as T | undefined
  }

  /**
   * Set a value by key.
   *
   * @param key - The storage key
   * @param value - The value to store (should be JSON-serializable)
   */
  async set(key: string, value: unknown): Promise<void> {
    this.#data.set(key, value)
  }

  /**
   * Delete a value by key.
   *
   * @param key - The storage key
   */
  async delete(key: string): Promise<void> {
    this.#data.delete(key)
  }

  /**
   * List all key-value pairs matching an optional prefix.
   *
   * @param prefix - Optional key prefix filter
   * @yields [key, value] tuples for matching entries
   */
  async *list(prefix?: string): AsyncIterable<[string, unknown]> {
    for (const [key, value] of this.#data) {
      if (!prefix || key.startsWith(prefix)) {
        yield [key, value]
      }
    }
  }

  /**
   * Check if a key exists.
   *
   * @param key - The storage key
   * @returns True if the key exists
   */
  has(key: string): boolean {
    return this.#data.has(key)
  }

  /**
   * Get the number of stored entries.
   */
  get size(): number {
    return this.#data.size
  }

  /**
   * Clear all stored data.
   * Useful for testing.
   */
  clear(): void {
    this.#data.clear()
  }
}
