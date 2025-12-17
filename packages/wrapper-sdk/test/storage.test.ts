import { beforeEach, describe, expect, it } from "vitest"
import { InMemoryStorage } from "../src/storage/memory"

describe(`InMemoryStorage`, () => {
  let storage: InMemoryStorage

  beforeEach(() => {
    storage = new InMemoryStorage()
  })

  describe(`get`, () => {
    it(`returns undefined for missing keys`, async () => {
      const result = await storage.get(`nonexistent`)
      expect(result).toBeUndefined()
    })

    it(`returns the stored value for existing keys`, async () => {
      await storage.set(`key`, `value`)
      const result = await storage.get(`key`)
      expect(result).toBe(`value`)
    })

    it(`preserves type information`, async () => {
      await storage.set(`user`, { name: `Alice`, age: 30 })
      const user = await storage.get<{ name: string; age: number }>(`user`)
      expect(user?.name).toBe(`Alice`)
      expect(user?.age).toBe(30)
    })
  })

  describe(`set`, () => {
    it(`stores primitive values`, async () => {
      await storage.set(`string`, `hello`)
      await storage.set(`number`, 42)
      await storage.set(`boolean`, true)
      await storage.set(`null`, null)

      expect(await storage.get(`string`)).toBe(`hello`)
      expect(await storage.get(`number`)).toBe(42)
      expect(await storage.get(`boolean`)).toBe(true)
      expect(await storage.get(`null`)).toBe(null)
    })

    it(`stores objects`, async () => {
      const obj = { foo: `bar`, nested: { value: 123 } }
      await storage.set(`obj`, obj)

      const result = await storage.get(`obj`)
      expect(result).toEqual(obj)
    })

    it(`stores arrays`, async () => {
      const arr = [1, 2, 3, { name: `test` }]
      await storage.set(`arr`, arr)

      const result = await storage.get(`arr`)
      expect(result).toEqual(arr)
    })

    it(`overwrites existing values`, async () => {
      await storage.set(`key`, `original`)
      await storage.set(`key`, `updated`)

      expect(await storage.get(`key`)).toBe(`updated`)
    })
  })

  describe(`delete`, () => {
    it(`removes existing keys`, async () => {
      await storage.set(`key`, `value`)
      await storage.delete(`key`)

      expect(await storage.get(`key`)).toBeUndefined()
    })

    it(`is idempotent for non-existent keys`, async () => {
      // Should not throw
      await storage.delete(`nonexistent`)
      expect(await storage.get(`nonexistent`)).toBeUndefined()
    })
  })

  describe(`list`, () => {
    it(`iterates all entries when no prefix is given`, async () => {
      await storage.set(`a`, 1)
      await storage.set(`b`, 2)
      await storage.set(`c`, 3)

      const entries: Array<[string, unknown]> = []
      for await (const entry of storage.list()) {
        entries.push(entry)
      }

      expect(entries).toHaveLength(3)
      expect(entries.map(([k]) => k).sort()).toEqual([`a`, `b`, `c`])
    })

    it(`filters entries by prefix`, async () => {
      await storage.set(`user:1`, { id: 1 })
      await storage.set(`user:2`, { id: 2 })
      await storage.set(`session:1`, { id: 1 })

      const entries: Array<[string, unknown]> = []
      for await (const entry of storage.list(`user:`)) {
        entries.push(entry)
      }

      expect(entries).toHaveLength(2)
      expect(entries.map(([k]) => k).sort()).toEqual([`user:1`, `user:2`])
    })

    it(`returns empty iterator for no matches`, async () => {
      await storage.set(`foo:1`, 1)

      const entries: Array<[string, unknown]> = []
      for await (const entry of storage.list(`bar:`)) {
        entries.push(entry)
      }

      expect(entries).toHaveLength(0)
    })

    it(`returns empty iterator for empty storage`, async () => {
      const entries: Array<[string, unknown]> = []
      for await (const entry of storage.list()) {
        entries.push(entry)
      }

      expect(entries).toHaveLength(0)
    })
  })

  describe(`has`, () => {
    it(`returns true for existing keys`, () => {
      storage.set(`key`, `value`)
      expect(storage.has(`key`)).toBe(true)
    })

    it(`returns false for non-existent keys`, () => {
      expect(storage.has(`nonexistent`)).toBe(false)
    })
  })

  describe(`size`, () => {
    it(`returns 0 for empty storage`, () => {
      expect(storage.size).toBe(0)
    })

    it(`returns the number of stored entries`, async () => {
      await storage.set(`a`, 1)
      await storage.set(`b`, 2)
      expect(storage.size).toBe(2)
    })

    it(`decreases after delete`, async () => {
      await storage.set(`a`, 1)
      await storage.set(`b`, 2)
      await storage.delete(`a`)
      expect(storage.size).toBe(1)
    })
  })

  describe(`clear`, () => {
    it(`removes all entries`, async () => {
      await storage.set(`a`, 1)
      await storage.set(`b`, 2)

      storage.clear()

      expect(storage.size).toBe(0)
      expect(await storage.get(`a`)).toBeUndefined()
      expect(await storage.get(`b`)).toBeUndefined()
    })

    it(`is idempotent on empty storage`, () => {
      storage.clear()
      expect(storage.size).toBe(0)
    })
  })
})
