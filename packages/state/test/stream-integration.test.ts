import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { DurableStreamTestServer } from "@durable-streams/server"
import { DurableStream } from "@durable-streams/writer"
import { MaterializedState } from "../src/index"
import type { ChangeMessage } from "../src/index"

describe(`Stream Integration`, () => {
  let server: DurableStreamTestServer
  let baseUrl: string

  beforeAll(async () => {
    server = new DurableStreamTestServer({ port: 0 })
    await server.start()
    baseUrl = server.url
  })

  afterAll(async () => {
    await server.stop()
  })

  it(`should write change events to a stream and materialize them`, async () => {
    const streamPath = `/state/config-${Date.now()}`

    // Create the stream with JSON mode
    const stream = await DurableStream.create({
      url: `${baseUrl}${streamPath}`,
      contentType: `application/json`,
    })

    // Write change events (no manual serialization needed)
    await stream.append({
      type: `config`,
      key: `theme`,
      value: `dark`,
      headers: { operation: `insert` },
    })

    await stream.append({
      type: `config`,
      key: `language`,
      value: `en`,
      headers: { operation: `insert` },
    })

    await stream.append({
      type: `config`,
      key: `theme`,
      value: `light`,
      old_value: `dark`,
      headers: { operation: `update` },
    })

    // Read back and materialize
    const state = new MaterializedState()
    const events = (await stream.json()) as Array<ChangeMessage>

    for (const event of events) {
      state.apply(event)
    }

    // Verify the materialized state
    expect(state.get(`config`, `theme`)).toBe(`light`)
    expect(state.get(`config`, `language`)).toBe(`en`)
  })

  it(`should stream and materialize events one at a time`, async () => {
    const streamPath = `/state/streaming-${Date.now()}`

    const stream = await DurableStream.create({
      url: `${baseUrl}${streamPath}`,
      contentType: `application/json`,
    })

    // Write events
    await stream.append({
      type: `user`,
      key: `123`,
      value: { name: `Kyle`, email: `kyle@example.com` },
      headers: { operation: `insert` },
    })

    await stream.append({
      type: `user`,
      key: `456`,
      value: { name: `Alice`, email: `alice@example.com` },
      headers: { operation: `insert` },
    })

    // Stream and materialize one at a time
    const state = new MaterializedState()

    for await (const event of stream.jsonStream({ live: false })) {
      state.apply(event as ChangeMessage)
    }

    // Verify
    expect(state.get(`user`, `123`)).toEqual({
      name: `Kyle`,
      email: `kyle@example.com`,
    })
    expect(state.get(`user`, `456`)).toEqual({
      name: `Alice`,
      email: `alice@example.com`,
    })

    const users = state.getType(`user`)
    expect(users.size).toBe(2)
  })

  it(`should handle multiple types in a stream`, async () => {
    const streamPath = `/state/multi-type-${Date.now()}`

    const stream = await DurableStream.create({
      url: `${baseUrl}${streamPath}`,
      contentType: `application/json`,
    })

    await stream.append({
      type: `user`,
      key: `123`,
      value: { name: `Kyle`, email: `kyle@example.com` },
      headers: { operation: `insert` },
    })

    await stream.append({
      type: `user`,
      key: `456`,
      value: { name: `Alice`, email: `alice@example.com` },
      headers: { operation: `insert` },
    })

    await stream.append({
      type: `config`,
      key: `theme`,
      value: `dark`,
      headers: { operation: `insert` },
    })

    // Read and materialize
    const state = new MaterializedState()
    const events = (await stream.json()) as Array<ChangeMessage>

    for (const event of events) {
      state.apply(event)
    }

    // Verify both types are materialized correctly
    expect(state.get(`user`, `123`)).toEqual({
      name: `Kyle`,
      email: `kyle@example.com`,
    })
    expect(state.get(`user`, `456`)).toEqual({
      name: `Alice`,
      email: `alice@example.com`,
    })
    expect(state.get(`config`, `theme`)).toBe(`dark`)

    // Verify we can query by type
    const users = state.getType(`user`)
    expect(users.size).toBe(2)
  })

  it(`should handle delete operations`, async () => {
    const streamPath = `/state/delete-${Date.now()}`

    const stream = await DurableStream.create({
      url: `${baseUrl}${streamPath}`,
      contentType: `application/json`,
    })

    await stream.append({
      type: `user`,
      key: `123`,
      value: { name: `Kyle` },
      headers: { operation: `insert` },
    })

    await stream.append({
      type: `user`,
      key: `456`,
      value: { name: `Alice` },
      headers: { operation: `insert` },
    })

    await stream.append({
      type: `user`,
      key: `123`,
      old_value: { name: `Kyle` },
      headers: { operation: `delete` },
    })

    // Read and materialize
    const state = new MaterializedState()
    const events = (await stream.json()) as Array<ChangeMessage>

    for (const event of events) {
      state.apply(event)
    }

    // User 123 should be deleted, 456 should remain
    expect(state.get(`user`, `123`)).toBeUndefined()
    expect(state.get(`user`, `456`)).toEqual({ name: `Alice` })

    const users = state.getType(`user`)
    expect(users.size).toBe(1)
  })

  it(`should resume from an offset and materialize new events`, async () => {
    const streamPath = `/state/resume-${Date.now()}`

    const stream = await DurableStream.create({
      url: `${baseUrl}${streamPath}`,
      contentType: `application/json`,
    })

    // Write initial events
    await stream.append({
      type: `config`,
      key: `theme`,
      value: `dark`,
      headers: { operation: `insert` },
    })

    await stream.append({
      type: `config`,
      key: `language`,
      value: `en`,
      headers: { operation: `insert` },
    })

    // Read and materialize initial state
    const state = new MaterializedState()
    const initialEvents = (await stream.json()) as Array<ChangeMessage>

    for (const event of initialEvents) {
      state.apply(event)
    }

    // Save the offset
    const savedOffset = stream.offset

    expect(state.get(`config`, `theme`)).toBe(`dark`)
    expect(state.get(`config`, `language`)).toBe(`en`)

    // Write more events
    await stream.append({
      type: `config`,
      key: `theme`,
      value: `light`,
      old_value: `dark`,
      headers: { operation: `update` },
    })

    await stream.append({
      type: `config`,
      key: `fontSize`,
      value: 14,
      headers: { operation: `insert` },
    })

    // Resume from saved offset and materialize new events
    for await (const event of stream.jsonStream({
      offset: savedOffset,
      live: false,
    })) {
      state.apply(event as ChangeMessage)
    }

    // Verify updated state
    expect(state.get(`config`, `theme`)).toBe(`light`)
    expect(state.get(`config`, `language`)).toBe(`en`)
    expect(state.get(`config`, `fontSize`)).toBe(14)
  })
})
