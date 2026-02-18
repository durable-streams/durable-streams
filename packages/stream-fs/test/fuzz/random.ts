/**
 * Seeded Random Number Generator for Fuzz Testing
 *
 * Provides reproducible random generation for fuzz tests. When a test fails,
 * you can reproduce it by using the same seed.
 */

export class SeededRandom {
  private state: number

  constructor(seed: number) {
    this.state = seed
  }

  next(): number {
    this.state = (this.state * 1103515245 + 12345) & 0x7fffffff
    return this.state / 0x7fffffff
  }

  int(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min
  }

  pick<T>(arr: ReadonlyArray<T>): T {
    return arr[this.int(0, arr.length - 1)]!
  }

  pickN<T>(arr: ReadonlyArray<T>, n: number): Array<T> {
    if (n >= arr.length) return [...arr]
    const result: Array<T> = []
    const remaining = [...arr]
    for (let i = 0; i < n; i++) {
      const idx = this.int(0, remaining.length - 1)
      result.push(remaining[idx]!)
      remaining.splice(idx, 1)
    }
    return result
  }

  chance(probability: number): boolean {
    return this.next() < probability
  }

  shuffle<T>(arr: Array<T>): Array<T> {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(0, i)
      ;[arr[i], arr[j]] = [arr[j]!, arr[i]!]
    }
    return arr
  }

  string(
    length: number,
    charset: string = `abcdefghijklmnopqrstuvwxyz`
  ): string {
    let result = ``
    for (let i = 0; i < length; i++) {
      result += this.pick([...charset])
    }
    return result
  }

  alphanumeric(length: number): string {
    return this.string(
      length,
      `abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789`
    )
  }

  filename(
    extensions: ReadonlyArray<string> = [`txt`, `md`, `json`, `ts`, `js`]
  ): string {
    const name = this.alphanumeric(this.int(3, 10))
    const ext = this.pick(extensions)
    return `${name}.${ext}`
  }

  path(maxDepth: number = 3): string {
    const depth = this.int(1, maxDepth)
    const parts: Array<string> = []
    for (let i = 0; i < depth; i++) {
      parts.push(this.alphanumeric(this.int(2, 8)))
    }
    return `/` + parts.join(`/`)
  }

  text(minLength: number, maxLength: number): string {
    const length = this.int(minLength, maxLength)
    const words = [
      `the`,
      `quick`,
      `brown`,
      `fox`,
      `jumps`,
      `over`,
      `lazy`,
      `dog`,
      `hello`,
      `world`,
      `test`,
      `file`,
      `content`,
      `data`,
      `lorem`,
      `ipsum`,
    ]
    const result: Array<string> = []
    let currentLength = 0
    while (currentLength < length) {
      const word = this.pick(words)
      result.push(word)
      currentLength += word.length + 1
    }
    return result.join(` `).slice(0, length)
  }

  weightedPick<T>(items: ReadonlyArray<T>, weights: ReadonlyArray<number>): T {
    const totalWeight = weights.reduce((a, b) => a + b, 0)
    let random = this.next() * totalWeight
    for (let i = 0; i < items.length; i++) {
      random -= weights[i]!
      if (random <= 0) return items[i]!
    }
    return items[items.length - 1]!
  }
}

// Fuzz Scenario Generator

export interface FuzzOperation {
  op:
    | `createFile`
    | `writeFile`
    | `deleteFile`
    | `mkdir`
    | `rmdir`
    | `readFile`
    | `list`
    | `move`
    | `copy`
    | `appendFile`
  path: string
  content?: string
  destination?: string
}

export interface FuzzScenario {
  seed: number
  operations: Array<FuzzOperation>
}

export interface FuzzGeneratorConfig {
  maxOperations: number
  maxFiles: number
  maxDirs: number
  maxDepth: number
  contentLength: { min: number; max: number }
  operationWeights: {
    createFile: number
    writeFile: number
    deleteFile: number
    mkdir: number
    rmdir: number
    readFile: number
    list: number
    move: number
    copy: number
    appendFile: number
  }
}

export const DEFAULT_FUZZ_CONFIG: FuzzGeneratorConfig = {
  maxOperations: 20,
  maxFiles: 5,
  maxDirs: 3,
  maxDepth: 3,
  contentLength: { min: 5, max: 100 },
  operationWeights: {
    createFile: 5,
    writeFile: 3,
    deleteFile: 2,
    mkdir: 4,
    rmdir: 1,
    readFile: 3,
    list: 2,
    move: 2,
    copy: 2,
    appendFile: 2,
  },
}

export function generateFuzzScenario(
  seed: number,
  config: Partial<FuzzGeneratorConfig> = {}
): FuzzScenario {
  const cfg = { ...DEFAULT_FUZZ_CONFIG, ...config }
  const rng = new SeededRandom(seed)
  const operations: Array<FuzzOperation> = []

  // Track filesystem state for valid operation generation
  const existingFiles = new Set<string>()
  const existingDirs = new Set<string>([`/`])

  const opTypes = Object.keys(cfg.operationWeights) as Array<
    keyof typeof cfg.operationWeights
  >
  const weights = opTypes.map((op) => cfg.operationWeights[op])

  const numOps = rng.int(cfg.maxOperations / 2, cfg.maxOperations)

  for (let i = 0; i < numOps; i++) {
    const opType = rng.weightedPick(opTypes, weights)

    switch (opType) {
      case `createFile`: {
        // Pick a parent directory and create a file in it
        const parentDirs = [...existingDirs]
        if (parentDirs.length === 0) break
        const parent = rng.pick(parentDirs)
        const filename = rng.filename()
        const path = parent === `/` ? `/${filename}` : `${parent}/${filename}`

        if (!existingFiles.has(path) && !existingDirs.has(path)) {
          const content = rng.text(cfg.contentLength.min, cfg.contentLength.max)
          operations.push({ op: `createFile`, path, content })
          existingFiles.add(path)
        }
        break
      }

      case `writeFile`: {
        // Write to an existing file
        const files = [...existingFiles]
        if (files.length === 0) break
        const path = rng.pick(files)
        const content = rng.text(cfg.contentLength.min, cfg.contentLength.max)
        operations.push({ op: `writeFile`, path, content })
        break
      }

      case `deleteFile`: {
        // Delete an existing file
        const files = [...existingFiles]
        if (files.length === 0) break
        const path = rng.pick(files)
        operations.push({ op: `deleteFile`, path })
        existingFiles.delete(path)
        break
      }

      case `mkdir`: {
        // Create a directory
        const parentDirs = [...existingDirs]
        if (parentDirs.length === 0) break
        const parent = rng.pick(parentDirs)
        const dirname = rng.alphanumeric(rng.int(3, 8))
        const path = parent === `/` ? `/${dirname}` : `${parent}/${dirname}`

        if (!existingFiles.has(path) && !existingDirs.has(path)) {
          operations.push({ op: `mkdir`, path })
          existingDirs.add(path)
        }
        break
      }

      case `rmdir`: {
        // Remove an empty directory (not root)
        const dirs = [...existingDirs].filter((d) => d !== `/`)
        if (dirs.length === 0) break

        // Find empty directories
        const emptyDirs = dirs.filter((dir) => {
          const prefix = dir === `/` ? `/` : `${dir}/`
          return (
            ![...existingFiles].some((f) => f.startsWith(prefix)) &&
            ![...existingDirs].some((d) => d !== dir && d.startsWith(prefix))
          )
        })

        if (emptyDirs.length === 0) break
        const path = rng.pick(emptyDirs)
        operations.push({ op: `rmdir`, path })
        existingDirs.delete(path)
        break
      }

      case `readFile`: {
        const files = [...existingFiles]
        if (files.length === 0) break
        const path = rng.pick(files)
        operations.push({ op: `readFile`, path })
        break
      }

      case `list`: {
        const dirs = [...existingDirs]
        if (dirs.length === 0) break
        const path = rng.pick(dirs)
        operations.push({ op: `list`, path })
        break
      }

      case `move`: {
        // Move an existing file to a new location in an existing directory
        const files = [...existingFiles]
        if (files.length === 0) break
        const sourcePath = rng.pick(files)
        const parentDirs = [...existingDirs]
        const parent = rng.pick(parentDirs)
        const filename = rng.filename()
        const destPath =
          parent === `/` ? `/${filename}` : `${parent}/${filename}`

        if (!existingFiles.has(destPath) && !existingDirs.has(destPath)) {
          operations.push({
            op: `move`,
            path: sourcePath,
            destination: destPath,
          })
          existingFiles.delete(sourcePath)
          existingFiles.add(destPath)
        }
        break
      }

      case `copy`: {
        // Copy an existing file to a new location
        const files = [...existingFiles]
        if (files.length === 0) break
        const sourcePath = rng.pick(files)
        const parentDirs = [...existingDirs]
        const parent = rng.pick(parentDirs)
        const filename = rng.filename()
        const destPath =
          parent === `/` ? `/${filename}` : `${parent}/${filename}`

        if (!existingFiles.has(destPath) && !existingDirs.has(destPath)) {
          operations.push({
            op: `copy`,
            path: sourcePath,
            destination: destPath,
          })
          existingFiles.add(destPath)
        }
        break
      }

      case `appendFile`: {
        // Append to an existing file
        const files = [...existingFiles]
        if (files.length === 0) break
        const path = rng.pick(files)
        const content = rng.text(cfg.contentLength.min, cfg.contentLength.max)
        operations.push({ op: `appendFile`, path, content })
        break
      }
    }
  }

  return { seed, operations }
}
