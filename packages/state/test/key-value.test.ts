import { describe, expect, it } from "vitest"
import { MaterializedState } from "../src/index"

describe(`Key-Value Store`, () => {
  describe(`MaterializedState`, () => {
    it(`should materialize insert events`, () => {
      const state = new MaterializedState()

      state.apply({
        type: `config`,
        key: `theme`,
        value: `dark`,
        headers: { operation: `insert` },
      })

      expect(state.get(`config`, `theme`)).toBe(`dark`)
    })

    it(`should materialize update events`, () => {
      const state = new MaterializedState()

      state.apply({
        type: `config`,
        key: `theme`,
        value: `dark`,
        headers: { operation: `insert` },
      })

      state.apply({
        type: `config`,
        key: `theme`,
        value: `light`,
        old_value: `dark`,
        headers: { operation: `update` },
      })

      expect(state.get(`config`, `theme`)).toBe(`light`)
    })

    it(`should materialize delete events`, () => {
      const state = new MaterializedState()

      state.apply({
        type: `config`,
        key: `theme`,
        value: `dark`,
        headers: { operation: `insert` },
      })

      state.apply({
        type: `config`,
        key: `theme`,
        old_value: `dark`,
        headers: { operation: `delete` },
      })

      expect(state.get(`config`, `theme`)).toBeUndefined()
    })

    it(`should handle multiple types in the same stream`, () => {
      const state = new MaterializedState()

      state.apply({
        type: `user`,
        key: `123`,
        value: { name: `Kyle`, email: `kyle@example.com` },
        headers: { operation: `insert` },
      })

      state.apply({
        type: `config`,
        key: `theme`,
        value: `dark`,
        headers: { operation: `insert` },
      })

      expect(state.get(`user`, `123`)).toEqual({
        name: `Kyle`,
        email: `kyle@example.com`,
      })
      expect(state.get(`config`, `theme`)).toBe(`dark`)
    })

    it(`should provide access to all rows of a type`, () => {
      const state = new MaterializedState()

      state.apply({
        type: `user`,
        key: `123`,
        value: { name: `Kyle`, email: `kyle@example.com` },
        headers: { operation: `insert` },
      })

      state.apply({
        type: `user`,
        key: `456`,
        value: { name: `Alice`, email: `alice@example.com` },
        headers: { operation: `insert` },
      })

      const users = state.getType(`user`)
      expect(users.size).toBe(2)
      expect(users.get(`123`)).toEqual({
        name: `Kyle`,
        email: `kyle@example.com`,
      })
      expect(users.get(`456`)).toEqual({
        name: `Alice`,
        email: `alice@example.com`,
      })
    })

    it(`should apply batch of events`, () => {
      const state = new MaterializedState()

      state.applyBatch([
        {
          type: `config`,
          key: `theme`,
          value: `dark`,
          headers: { operation: `insert` },
        },
        {
          type: `config`,
          key: `language`,
          value: `en`,
          headers: { operation: `insert` },
        },
      ])

      expect(state.get(`config`, `theme`)).toBe(`dark`)
      expect(state.get(`config`, `language`)).toBe(`en`)
    })

    it(`should replay from scratch`, () => {
      const events = [
        {
          type: `config`,
          key: `theme`,
          value: `dark`,
          headers: { operation: `insert` },
        },
        {
          type: `config`,
          key: `theme`,
          value: `light`,
          headers: { operation: `update` },
        },
      ]

      const state = new MaterializedState()
      state.clear()
      state.applyBatch(events)

      expect(state.get(`config`, `theme`)).toBe(`light`)
    })
  })
})
