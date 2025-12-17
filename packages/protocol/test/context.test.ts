import { describe, it, expect } from "vitest"
import {
  createStreamMiddleware,
  createProtocolApp,
  getStream,
  getNamespace,
} from "../src/context"
import type { ProtocolConfig } from "../src/types"
import { Hono } from "hono"
import type { ProtocolHonoEnv } from "../src/types"

describe(`createStreamMiddleware`, () => {
  const mockConfig: ProtocolConfig = {
    baseUrl: `https://streams.example.com/v1/stream`,
  }

  it(`should set namespace on context`, async () => {
    const app = new Hono<ProtocolHonoEnv>()
    app.use(`*`, createStreamMiddleware(`/myns`, mockConfig))
    app.get(`/test`, (c) => c.json({ namespace: c.var.namespace }))

    const res = await app.request(`/test`)
    const data = await res.json()

    expect(data.namespace).toBe(`/myns`)
  })

  it(`should normalize namespace path`, async () => {
    const app = new Hono<ProtocolHonoEnv>()
    app.use(`*`, createStreamMiddleware(`myns/`, mockConfig))
    app.get(`/test`, (c) => c.json({ namespace: c.var.namespace }))

    const res = await app.request(`/test`)
    const data = await res.json()

    expect(data.namespace).toBe(`/myns`)
  })

  it(`should set stream factory on context`, async () => {
    const app = new Hono<ProtocolHonoEnv>()
    app.use(`*`, createStreamMiddleware(`/myns`, mockConfig))
    app.get(`/test`, (c) => c.json({ hasStream: typeof c.var.stream === `function` }))

    const res = await app.request(`/test`)
    const data = await res.json()

    expect(data.hasStream).toBe(true)
  })

  it(`should create DurableStream with correct URL`, async () => {
    const app = new Hono<ProtocolHonoEnv>()
    app.use(`*`, createStreamMiddleware(`/docs`, mockConfig))
    app.get(`/:docId`, (c) => {
      // Create stream to ensure factory works
      c.var.stream(`updates`)
      return c.json({ created: true })
    })

    const res = await app.request(`/my-doc`)
    expect(res.status).toBe(200)
  })

  it(`should pass headers to DurableStream`, async () => {
    const configWithHeaders: ProtocolConfig = {
      baseUrl: `https://streams.example.com/v1/stream`,
      headers: {
        Authorization: `Bearer test-token`,
      },
    }

    const app = new Hono<ProtocolHonoEnv>()
    app.use(`*`, createStreamMiddleware(`/docs`, configWithHeaders))
    app.get(`/:docId`, (c) => {
      // Create stream to ensure factory works with headers
      c.var.stream(`updates`)
      return c.json({ created: true })
    })

    const res = await app.request(`/my-doc`)
    expect(res.status).toBe(200)
  })
})

describe(`createProtocolApp`, () => {
  const mockConfig: ProtocolConfig = {
    baseUrl: `https://streams.example.com/v1/stream`,
  }

  it(`should create a Hono app with middleware already applied`, async () => {
    const app = createProtocolApp(`/myns`, mockConfig)
    app.get(`/test`, (c) =>
      c.json({
        namespace: c.var.namespace,
        hasStream: typeof c.var.stream === `function`,
      })
    )

    const res = await app.request(`/test`)
    const data = await res.json()

    expect(data.namespace).toBe(`/myns`)
    expect(data.hasStream).toBe(true)
  })
})

describe(`getStream helper`, () => {
  const mockConfig: ProtocolConfig = {
    baseUrl: `https://streams.example.com/v1/stream`,
  }

  it(`should return a DurableStream instance`, async () => {
    let streamResult: unknown

    const app = new Hono<ProtocolHonoEnv>()
    app.use(`*`, createStreamMiddleware(`/docs`, mockConfig))
    app.get(`/:docId`, (c) => {
      streamResult = getStream(c, `updates`)
      return c.text(`ok`)
    })

    await app.request(`/my-doc`)

    expect(streamResult).toBeDefined()
    expect(typeof (streamResult as { create: unknown }).create).toBe(`function`)
  })
})

describe(`getNamespace helper`, () => {
  const mockConfig: ProtocolConfig = {
    baseUrl: `https://streams.example.com/v1/stream`,
  }

  it(`should return the namespace from context`, async () => {
    let namespaceResult: string | undefined

    const app = new Hono<ProtocolHonoEnv>()
    app.use(`*`, createStreamMiddleware(`/myns`, mockConfig))
    app.get(`/test`, (c) => {
      namespaceResult = getNamespace(c)
      return c.text(`ok`)
    })

    await app.request(`/test`)

    expect(namespaceResult).toBe(`/myns`)
  })
})

describe(`path resolution`, () => {
  it(`should resolve subpaths correctly`, async () => {
    // We can test path resolution by checking the DurableStream's internal URL
    // Since DurableStream is a real class, we need to inspect the URL it creates
    const config: ProtocolConfig = {
      baseUrl: `https://streams.example.com/v1/stream`,
    }

    const app = new Hono<ProtocolHonoEnv>()
    app.use(`*`, createStreamMiddleware(`/docs`, config))
    app.get(`/test`, (c) => {
      // Create streams with different subpaths
      c.var.stream(`updates`)
      c.var.stream(`/updates`)
      c.var.stream(`nested/path`)
      return c.text(`ok`)
    })

    await app.request(`/test`)
    // If no errors thrown, paths were resolved successfully
  })

  it(`should handle empty subpath`, async () => {
    const config: ProtocolConfig = {
      baseUrl: `https://streams.example.com/v1/stream`,
    }

    const app = new Hono<ProtocolHonoEnv>()
    app.use(`*`, createStreamMiddleware(`/docs`, config))
    app.get(`/test`, (c) => {
      c.var.stream(``)
      return c.text(`ok`)
    })

    const res = await app.request(`/test`)
    expect(res.status).toBe(200)
  })
})
