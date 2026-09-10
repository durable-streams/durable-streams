import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { describe, expect, it } from "vitest"

const srcDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  `../src`
)

// Resolve a relative import specifier (e.g. "./types") to an on-disk .ts file.
function resolveRelative(fromFile: string, spec: string): string | null {
  const base = path.resolve(path.dirname(fromFile), spec)
  for (const candidate of [base, `${base}.ts`, path.join(base, `index.ts`)]) {
    if (candidate.endsWith(`.ts`) && existsSync(candidate)) return candidate
  }
  return null
}

// Collect every source module reachable from `entry` by following relative imports.
function moduleGraph(entry: string): Array<string> {
  const seen = new Set<string>()
  const stack = [entry]
  while (stack.length > 0) {
    const file = stack.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    const code = readFileSync(file, `utf8`)
    const relativeImport = /(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/g
    let match: RegExpExecArray | null
    while ((match = relativeImport.exec(code)) !== null) {
      const resolved = resolveRelative(file, match[1]!)
      if (resolved) stack.push(resolved)
    }
  }
  return [...seen]
}

function modulesImportingTanstackDb(files: Array<string>): Array<string> {
  return files
    .filter((f) => /["']@tanstack\/db["']/.test(readFileSync(f, `utf8`)))
    .map((f) => path.relative(srcDir, f))
}

describe(`@durable-streams/state main entry`, () => {
  it(`does not pull in @tanstack/db anywhere in its module graph`, () => {
    const offenders = modulesImportingTanstackDb(
      moduleGraph(path.join(srcDir, `index.ts`))
    )
    expect(offenders).toEqual([])
  })

  it(`exposes the db-free protocol surface`, async () => {
    const mod = await import(`../src/index`)
    expect(typeof mod.createStateSchema).toBe(`function`)
    expect(typeof mod.MaterializedState).toBe(`function`)
    expect(typeof mod.isChangeEvent).toBe(`function`)
    // createStreamDB is reactive/TanStack-backed: it must NOT live on the main entry.
    expect(`createStreamDB` in mod).toBe(false)
  })
})

describe(`@durable-streams/state/db subpath`, () => {
  it(`is where the TanStack-backed surface lives`, async () => {
    const dbEntry = path.join(srcDir, `db.ts`)
    expect(existsSync(dbEntry)).toBe(true)
    // The /db entry is expected to depend on @tanstack/db.
    expect(
      modulesImportingTanstackDb(moduleGraph(dbEntry)).length
    ).toBeGreaterThan(0)

    const mod = await import(`../src/db`)
    expect(typeof mod.createStreamDB).toBe(`function`)
    // Convenience re-export from the db-free entry stays available here too.
    expect(typeof mod.createStateSchema).toBe(`function`)
  })
})
