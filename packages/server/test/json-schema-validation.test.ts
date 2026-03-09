import * as fs from "node:fs"
import * as path from "node:path"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { DurableStreamTestServer } from "@durable-streams/server"

async function createSchemaFixtureServer(
  schemaDocument: Record<string, unknown>,
  statusCode = 200
): Promise<{
  url: string
  stop: () => Promise<void>
}> {
  const server = createServer((req, res) => {
    if (req.url !== `/schema.json`) {
      res.writeHead(404)
      res.end(`Not found`)
      return
    }

    res.writeHead(statusCode, { "content-type": `application/json` })
    res.end(JSON.stringify(schemaDocument))
  })

  await new Promise<void>((resolve) => server.listen(0, `127.0.0.1`, resolve))
  const address = server.address()
  if (!address || typeof address === `string`) {
    throw new Error(`Could not determine schema fixture address`)
  }

  return {
    url: `http://127.0.0.1:${address.port}/schema.json`,
    stop: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      ),
  }
}

describe.each([`in-memory`, `file-backed`])(
  `JSON schema validation (%s)`,
  (mode) => {
    let server: DurableStreamTestServer
    let dataDir: string | undefined

    beforeEach(async () => {
      if (mode === `file-backed`) {
        dataDir = fs.mkdtempSync(path.join(tmpdir(), `schema-mode-`))
      }
      server = new DurableStreamTestServer({
        dataDir,
        port: 0,
        longPollTimeout: 250,
      })
      await server.start()
    })

    afterEach(async () => {
      await server.stop()
      if (dataDir) {
        fs.rmSync(dataDir, { recursive: true, force: true })
        dataDir = undefined
      }
    })

    test(`supports inline schema creation, validation, HEAD metadata, and GET ?schema`, async () => {
      const streamPath = `/schema-inline-${Date.now()}`
      const schema = {
        type: `object`,
        required: [`event`],
        properties: {
          event: { type: `string` },
        },
      }

      const createResponse = await fetch(`${server.url}${streamPath}`, {
        method: `PUT`,
        headers: {
          "content-type": `application/schema+json`,
          "stream-content-type": `application/json`,
        },
        body: JSON.stringify(schema),
      })

      expect(createResponse.status).toBe(201)
      expect(createResponse.headers.get(`content-type`)).toBe(
        `application/json`
      )

      const headResponse = await fetch(`${server.url}${streamPath}`, {
        method: `HEAD`,
      })
      expect(headResponse.status).toBe(200)
      const digest = headResponse.headers.get(`stream-schema-digest`)
      expect(digest).toMatch(/^sha-256:[a-f0-9]{64}$/)
      const link = headResponse.headers.get(`link`)
      expect(link).toContain(`rel="describedby"`)
      expect(link).toContain(`${streamPath}?schema`)

      const getSchemaResponse = await fetch(
        `${server.url}${streamPath}?schema`,
        {
          method: `GET`,
        }
      )
      expect(getSchemaResponse.status).toBe(200)
      expect(getSchemaResponse.headers.get(`content-type`)).toBe(
        `application/schema+json`
      )
      const effectiveSchema = (await getSchemaResponse.json()) as Record<
        string,
        unknown
      >
      expect(effectiveSchema.$schema).toBe(
        `https://json-schema.org/draft/2020-12/schema`
      )
      expect(getSchemaResponse.headers.get(`stream-schema-digest`)).toBe(digest)

      const validAppend = await fetch(`${server.url}${streamPath}`, {
        method: `POST`,
        headers: { "content-type": `application/json` },
        body: JSON.stringify({ event: `created` }),
      })
      expect(validAppend.status).toBe(204)

      const invalidAppend = await fetch(`${server.url}${streamPath}`, {
        method: `POST`,
        headers: { "content-type": `application/json` },
        body: JSON.stringify({ nope: true }),
      })
      expect(invalidAppend.status).toBe(422)
    })

    test(`supports schema URL creation and digest-based idempotent equivalence`, async () => {
      const streamPath = `/schema-url-${Date.now()}`
      const schema = {
        type: `object`,
        required: [`event`],
        properties: {
          event: { type: `string` },
        },
      }
      const fixture = await createSchemaFixtureServer(schema)
      try {
        const createFromUrl = await fetch(`${server.url}${streamPath}`, {
          method: `PUT`,
          headers: {
            "content-type": `application/json`,
            "stream-schema-url": fixture.url,
          },
          body: JSON.stringify([{ event: `created` }]),
        })
        expect(createFromUrl.status).toBe(201)

        const idempotentInline = await fetch(`${server.url}${streamPath}`, {
          method: `PUT`,
          headers: {
            "content-type": `application/schema+json`,
            "stream-content-type": `application/json`,
          },
          body: JSON.stringify(schema),
        })
        expect(idempotentInline.status).toBe(200)

        const conflictNoSchema = await fetch(`${server.url}${streamPath}`, {
          method: `PUT`,
          headers: {
            "content-type": `application/json`,
          },
        })
        expect(conflictNoSchema.status).toBe(409)

        const headResponse = await fetch(`${server.url}${streamPath}`, {
          method: `HEAD`,
        })
        expect(headResponse.headers.get(`stream-schema-url`)).toBe(fixture.url)
      } finally {
        await fixture.stop()
      }
    })

    test(`rejects invalid schema URL and leaves no partial stream`, async () => {
      const streamPath = `/schema-url-invalid-${Date.now()}`
      const createResponse = await fetch(`${server.url}${streamPath}`, {
        method: `PUT`,
        headers: {
          "content-type": `application/json`,
          "stream-schema-url": `/not-absolute`,
        },
      })
      expect(createResponse.status).toBe(400)

      const headResponse = await fetch(`${server.url}${streamPath}`, {
        method: `HEAD`,
      })
      expect(headResponse.status).toBe(404)
    })

    test(`enforces ?schema query parameter exclusivity and 404 for no-schema streams`, async () => {
      const streamPath = `/schema-query-${Date.now()}`
      const createResponse = await fetch(`${server.url}${streamPath}`, {
        method: `PUT`,
        headers: { "content-type": `application/json` },
      })
      expect(createResponse.status).toBe(201)

      const noSchemaResponse = await fetch(
        `${server.url}${streamPath}?schema`,
        {
          method: `GET`,
        }
      )
      expect(noSchemaResponse.status).toBe(404)

      const invalidComboResponse = await fetch(
        `${server.url}${streamPath}?schema&offset=-1`,
        {
          method: `GET`,
        }
      )
      expect(invalidComboResponse.status).toBe(400)
    })
  }
)
