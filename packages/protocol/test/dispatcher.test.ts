import { describe, it, expect, beforeEach } from "vitest"
import { StreamStore } from "@durable-streams/server"
import {
  createDispatcher,
  defineProtocol,
  createProtocolBuilder,
} from "../src/index"

describe(`ProtocolDispatcher`, () => {
  let store: StreamStore
  let dispatcher: ReturnType<typeof createDispatcher>

  beforeEach(() => {
    store = new StreamStore()
    dispatcher = createDispatcher(store)
  })

  describe(`protocol registration`, () => {
    it(`should register a protocol`, async () => {
      const protocol = defineProtocol({
        name: `test`,
        namespace: `/test`,
        handle: async () => ({ status: 200, body: `ok` }),
      })

      await dispatcher.register(protocol)
      expect(dispatcher.getProtocol(`test`)).toBe(protocol)
    })

    it(`should list registered protocols`, async () => {
      const p1 = defineProtocol({
        name: `proto1`,
        namespace: `/proto1`,
        handle: async () => ({ status: 200 }),
      })
      const p2 = defineProtocol({
        name: `proto2`,
        namespace: `/proto2`,
        handle: async () => ({ status: 200 }),
      })

      await dispatcher.register(p1)
      await dispatcher.register(p2)

      const protocols = dispatcher.listProtocols()
      expect(protocols).toHaveLength(2)
      expect(protocols.map((p) => p.name)).toContain(`proto1`)
      expect(protocols.map((p) => p.name)).toContain(`proto2`)
    })

    it(`should unregister a protocol`, async () => {
      const protocol = defineProtocol({
        name: `test`,
        namespace: `/test`,
        handle: async () => ({ status: 200 }),
      })

      await dispatcher.register(protocol)
      expect(dispatcher.getProtocol(`test`)).toBeTruthy()

      const unregistered = await dispatcher.unregister(`test`)
      expect(unregistered).toBe(true)
      expect(dispatcher.getProtocol(`test`)).toBeUndefined()
    })

    it(`should detect conflicting namespaces`, async () => {
      const p1 = defineProtocol({
        name: `proto1`,
        namespace: `/test`,
        handle: async () => ({ status: 200 }),
      })
      const p2 = defineProtocol({
        name: `proto2`,
        namespace: `/test`,
        handle: async () => ({ status: 200 }),
      })

      await dispatcher.register(p1)
      await expect(dispatcher.register(p2)).rejects.toThrow(/conflicts/)
    })

    it(`should call onRegister hook`, async () => {
      let registered = false

      const protocol = defineProtocol({
        name: `test`,
        namespace: `/test`,
        handle: async () => ({ status: 200 }),
        hooks: {
          onRegister: async () => {
            registered = true
          },
        },
      })

      await dispatcher.register(protocol)
      expect(registered).toBe(true)
    })

    it(`should call onUnregister hook`, async () => {
      let unregistered = false

      const protocol = defineProtocol({
        name: `test`,
        namespace: `/test`,
        handle: async () => ({ status: 200 }),
        hooks: {
          onUnregister: async () => {
            unregistered = true
          },
        },
      })

      await dispatcher.register(protocol)
      await dispatcher.unregister(`test`)
      expect(unregistered).toBe(true)
    })
  })

  describe(`request matching`, () => {
    it(`should match exact namespace`, async () => {
      await dispatcher.register(
        defineProtocol({
          name: `test`,
          namespace: `/test`,
          handle: async () => ({ status: 200, body: `matched` }),
        })
      )

      const match = dispatcher.match(`/v1/stream/test`)
      expect(match).toBeTruthy()
      expect(match?.protocol.name).toBe(`test`)
    })

    it(`should match wildcard namespace`, async () => {
      await dispatcher.register(
        defineProtocol({
          name: `test`,
          namespace: `/test/*`,
          handle: async () => ({ status: 200 }),
        })
      )

      const match1 = dispatcher.match(`/v1/stream/test/foo`)
      expect(match1).toBeTruthy()
      expect(match1?.wildcard).toBe(`foo`)

      const match2 = dispatcher.match(`/v1/stream/test/foo/bar`)
      expect(match2).toBeTruthy()
      expect(match2?.wildcard).toBe(`foo/bar`)
    })

    it(`should match named parameters`, async () => {
      await dispatcher.register(
        defineProtocol({
          name: `test`,
          namespace: `/docs/:docId`,
          handle: async () => ({ status: 200 }),
        })
      )

      const match = dispatcher.match(`/v1/stream/docs/my-doc`)
      expect(match).toBeTruthy()
      expect(match?.params.docId).toBe(`my-doc`)
    })

    it(`should match combined patterns`, async () => {
      await dispatcher.register(
        defineProtocol({
          name: `test`,
          namespace: `/yjs/:docId/*`,
          handle: async () => ({ status: 200 }),
        })
      )

      const match = dispatcher.match(`/v1/stream/yjs/doc-123/awareness`)
      expect(match).toBeTruthy()
      expect(match?.params.docId).toBe(`doc-123`)
      expect(match?.wildcard).toBe(`awareness`)
    })

    it(`should prefer more specific patterns`, async () => {
      await dispatcher.register(
        defineProtocol({
          name: `general`,
          namespace: `/api/*`,
          handle: async () => ({ status: 200, body: `general` }),
        })
      )
      await dispatcher.register(
        defineProtocol({
          name: `specific`,
          namespace: `/api/users`,
          handle: async () => ({ status: 200, body: `specific` }),
        })
      )

      const match = dispatcher.match(`/v1/stream/api/users`)
      expect(match?.protocol.name).toBe(`specific`)
    })
  })

  describe(`request dispatching`, () => {
    it(`should dispatch to matching protocol`, async () => {
      await dispatcher.register(
        defineProtocol({
          name: `test`,
          namespace: `/test`,
          handle: async (req) => ({
            status: 200,
            body: `method: ${req.method}`,
          }),
        })
      )

      const response = await dispatcher.dispatch(`GET`, `/v1/stream/test`, {
        url: new URL(`http://localhost/v1/stream/test`),
        headers: new Headers(),
      })

      expect(response.status).toBe(200)
      expect(response.body).toBe(`method: GET`)
    })

    it(`should provide request params to handler`, async () => {
      await dispatcher.register(
        defineProtocol({
          name: `test`,
          namespace: `/docs/:docId/*`,
          handle: async (req) => ({
            status: 200,
            body: JSON.stringify({
              docId: req.params.docId,
              wildcard: req.wildcard,
              subpath: req.subpath,
            }),
          }),
        })
      )

      const response = await dispatcher.dispatch(
        `POST`,
        `/v1/stream/docs/my-doc/updates`,
        {
          url: new URL(`http://localhost/v1/stream/docs/my-doc/updates`),
          headers: new Headers(),
        }
      )

      expect(response.status).toBe(200)
      const body = JSON.parse(response.body as string)
      expect(body.docId).toBe(`my-doc`)
      expect(body.wildcard).toBe(`updates`)
    })

    it(`should provide scoped context to handler`, async () => {
      let contextNamespace: string | undefined

      await dispatcher.register(
        defineProtocol({
          name: `test`,
          namespace: `/myns`,
          handle: async (req, ctx) => {
            contextNamespace = ctx.namespace
            return { status: 200 }
          },
        })
      )

      await dispatcher.dispatch(`GET`, `/v1/stream/myns/sub`, {
        url: new URL(`http://localhost/v1/stream/myns/sub`),
        headers: new Headers(),
      })

      expect(contextNamespace).toBe(`/myns`)
    })

    it(`should return 404 for unmatched paths`, async () => {
      const response = await dispatcher.dispatch(`GET`, `/v1/stream/unknown`, {
        url: new URL(`http://localhost/v1/stream/unknown`),
        headers: new Headers(),
      })

      expect(response.status).toBe(404)
    })

    it(`should pass through when handler returns undefined`, async () => {
      await dispatcher.register(
        defineProtocol({
          name: `test`,
          namespace: `/test`,
          handle: async () => undefined,
        })
      )

      const response = await dispatcher.dispatch(`GET`, `/v1/stream/test`, {
        url: new URL(`http://localhost/v1/stream/test`),
        headers: new Headers(),
      })

      // Passthrough returns 200 with empty body
      expect(response.status).toBe(200)
    })
  })

  describe(`ProtocolBuilder`, () => {
    it(`should build a protocol with route handlers`, async () => {
      const protocol = createProtocolBuilder(`test`, `/api/*`)
        .get(`/users`, async () => ({
          status: 200,
          body: JSON.stringify([{ id: 1, name: `Alice` }]),
        }))
        .post(`/users`, async (req) => ({
          status: 201,
          body: JSON.stringify({ created: true }),
        }))
        .build()

      await dispatcher.register(protocol)

      const getResponse = await dispatcher.dispatch(
        `GET`,
        `/v1/stream/api/users`,
        {
          url: new URL(`http://localhost/v1/stream/api/users`),
          headers: new Headers(),
        }
      )
      expect(getResponse.status).toBe(200)

      const postResponse = await dispatcher.dispatch(
        `POST`,
        `/v1/stream/api/users`,
        {
          url: new URL(`http://localhost/v1/stream/api/users`),
          headers: new Headers(),
        }
      )
      expect(postResponse.status).toBe(201)
    })

    it(`should support wildcard route paths`, async () => {
      const protocol = createProtocolBuilder(`test`, `/api/*`)
        .all(`*`, async (req) => ({
          status: 200,
          body: `subpath: ${req.subpath}`,
        }))
        .build()

      await dispatcher.register(protocol)

      const response = await dispatcher.dispatch(
        `GET`,
        `/v1/stream/api/any/path/here`,
        {
          url: new URL(`http://localhost/v1/stream/api/any/path/here`),
          headers: new Headers(),
        }
      )

      expect(response.status).toBe(200)
      expect(response.body).toContain(`any/path/here`)
    })
  })
})
