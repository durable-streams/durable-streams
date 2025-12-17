import { describe, it, expect } from "vitest"
import { createDispatcher, defineProtocol, stream, mountProtocol } from "../src/index"
import { Hono } from "hono"
import type { ProtocolHonoEnv, ProtocolConfig } from "../src/types"

describe(`createDispatcher`, () => {
  const mockConfig: ProtocolConfig = {
    baseUrl: `https://streams.example.com/v1/stream`,
  }

  it(`should create a Hono app`, () => {
    const app = createDispatcher(mockConfig, [])
    expect(app).toBeDefined()
    expect(app.fetch).toBeDefined()
  })

  it(`should mount protocols at their namespaces`, async () => {
    const protocol = defineProtocol({
      name: `test`,
      namespace: `/test`,
      setup: (app) => {
        app.get(`/hello`, (c) => c.text(`Hello from test`))
      },
    })

    const app = createDispatcher(mockConfig, [protocol])

    const res = await app.request(`/test/hello`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(`Hello from test`)
  })

  it(`should mount multiple protocols`, async () => {
    const protocol1 = defineProtocol({
      name: `proto1`,
      namespace: `/one`,
      setup: (app) => {
        app.get(`/`, (c) => c.text(`Protocol One`))
      },
    })

    const protocol2 = defineProtocol({
      name: `proto2`,
      namespace: `/two`,
      setup: (app) => {
        app.get(`/`, (c) => c.text(`Protocol Two`))
      },
    })

    const app = createDispatcher(mockConfig, [protocol1, protocol2])

    const res1 = await app.request(`/one`)
    expect(res1.status).toBe(200)
    expect(await res1.text()).toBe(`Protocol One`)

    const res2 = await app.request(`/two`)
    expect(res2.status).toBe(200)
    expect(await res2.text()).toBe(`Protocol Two`)
  })

  it(`should return 404 for unmatched routes`, async () => {
    const protocol = defineProtocol({
      name: `test`,
      namespace: `/test`,
      setup: (app) => {
        app.get(`/hello`, (c) => c.text(`Hello`))
      },
    })

    const app = createDispatcher(mockConfig, [protocol])

    const res = await app.request(`/unknown`)
    expect(res.status).toBe(404)
  })

  it(`should handle nested routes within namespace`, async () => {
    const protocol = defineProtocol({
      name: `docs`,
      namespace: `/docs`,
      setup: (app) => {
        app.get(`/:docId`, (c) => c.text(`Doc: ${c.req.param(`docId`)}`))
        app.get(`/:docId/updates`, (c) => c.text(`Updates for: ${c.req.param(`docId`)}`))
      },
    })

    const app = createDispatcher(mockConfig, [protocol])

    const res1 = await app.request(`/docs/my-doc`)
    expect(res1.status).toBe(200)
    expect(await res1.text()).toBe(`Doc: my-doc`)

    const res2 = await app.request(`/docs/my-doc/updates`)
    expect(res2.status).toBe(200)
    expect(await res2.text()).toBe(`Updates for: my-doc`)
  })

  it(`should support different HTTP methods`, async () => {
    const protocol = defineProtocol({
      name: `api`,
      namespace: `/api`,
      setup: (app) => {
        app.get(`/resource`, (c) => c.text(`GET`))
        app.post(`/resource`, (c) => c.text(`POST`))
        app.put(`/resource`, (c) => c.text(`PUT`))
        app.delete(`/resource`, (c) => c.text(`DELETE`))
      },
    })

    const app = createDispatcher(mockConfig, [protocol])

    expect(await (await app.request(`/api/resource`, { method: `GET` })).text()).toBe(`GET`)
    expect(await (await app.request(`/api/resource`, { method: `POST` })).text()).toBe(`POST`)
    expect(await (await app.request(`/api/resource`, { method: `PUT` })).text()).toBe(`PUT`)
    expect(await (await app.request(`/api/resource`, { method: `DELETE` })).text()).toBe(`DELETE`)
  })
})

describe(`mountProtocol`, () => {
  const mockConfig: ProtocolConfig = {
    baseUrl: `https://streams.example.com/v1/stream`,
  }

  it(`should mount a protocol onto an existing app`, async () => {
    const app = new Hono<ProtocolHonoEnv>()
    app.get(`/`, (c) => c.text(`Root`))

    const protocol = defineProtocol({
      name: `addon`,
      namespace: `/addon`,
      setup: (protoApp) => {
        protoApp.get(`/feature`, (c) => c.text(`Addon Feature`))
      },
    })

    mountProtocol(app, mockConfig, protocol)

    const rootRes = await app.request(`/`)
    expect(rootRes.status).toBe(200)
    expect(await rootRes.text()).toBe(`Root`)

    const addonRes = await app.request(`/addon/feature`)
    expect(addonRes.status).toBe(200)
    expect(await addonRes.text()).toBe(`Addon Feature`)
  })
})

describe(`defineProtocol`, () => {
  const mockConfig: ProtocolConfig = {
    baseUrl: `https://streams.example.com/v1/stream`,
  }

  it(`should create a protocol with name and namespace`, () => {
    const protocol = defineProtocol({
      name: `my-protocol`,
      namespace: `/my`,
      setup: () => {},
    })

    expect(protocol.name).toBe(`my-protocol`)
    expect(protocol.namespace).toBe(`/my`)
  })

  it(`should provide config to setup function`, async () => {
    let receivedConfig: ProtocolConfig | undefined

    const protocol = defineProtocol({
      name: `test`,
      namespace: `/test`,
      setup: (app, config) => {
        receivedConfig = config
        app.get(`/`, (c) => c.text(`ok`))
      },
    })

    const app = createDispatcher(mockConfig, [protocol])
    await app.request(`/test`)

    expect(receivedConfig).toBe(mockConfig)
  })

  it(`should set up stream context in handlers`, async () => {
    let hasStreamFn = false
    let hasNamespace = false

    const protocol = defineProtocol({
      name: `test`,
      namespace: `/myns`,
      setup: (app) => {
        app.get(`/check`, (c) => {
          hasStreamFn = typeof c.var.stream === `function`
          hasNamespace = typeof c.var.namespace === `string`
          return c.text(`ok`)
        })
      },
    })

    const app = createDispatcher(mockConfig, [protocol])
    await app.request(`/myns/check`)

    expect(hasStreamFn).toBe(true)
    expect(hasNamespace).toBe(true)
  })

  it(`should provide correct namespace in context`, async () => {
    let contextNamespace: string | undefined

    const protocol = defineProtocol({
      name: `test`,
      namespace: `/myns`,
      setup: (app) => {
        app.get(`/ns`, (c) => {
          contextNamespace = c.var.namespace
          return c.text(`ok`)
        })
      },
    })

    const app = createDispatcher(mockConfig, [protocol])
    await app.request(`/myns/ns`)

    expect(contextNamespace).toBe(`/myns`)
  })
})

describe(`stream helper`, () => {
  const mockConfig: ProtocolConfig = {
    baseUrl: `https://streams.example.com/v1/stream`,
  }

  it(`should return a DurableStream instance`, async () => {
    let streamInstance: unknown

    const protocol = defineProtocol({
      name: `test`,
      namespace: `/docs`,
      setup: (app) => {
        app.get(`/:id`, (c) => {
          streamInstance = stream(c, `updates`)
          return c.text(`ok`)
        })
      },
    })

    const app = createDispatcher(mockConfig, [protocol])
    await app.request(`/docs/my-doc`)

    expect(streamInstance).toBeDefined()
    expect(typeof (streamInstance as { create: unknown }).create).toBe(`function`)
  })
})
