/**
 * PromptObject Runtime
 *
 * Manages the ecosystem of prompt objects, providing:
 * - Object creation and registry
 * - Message routing
 * - Standard library of primitives
 */

import { PromptObject } from "./prompt-object.js"
import type { PromptObjectRuntime as IPromptObjectRuntime } from "./prompt-object.js"
import type {
  Capability,
  CapabilityInfo,
  CreateObjectOptions,
  Message,
  PromptObjectHandle,
  PromptObjectInfo,
  RuntimeConfig,
  RuntimeHandle,
  SendOptions,
} from "./types.js"

/**
 * The runtime that manages all prompt objects
 */
export class Runtime implements IPromptObjectRuntime, RuntimeHandle {
  readonly config: RuntimeConfig
  private objects: Map<string, PromptObject> = new Map()
  private primitives: Map<string, Capability> = new Map()

  constructor(config: RuntimeConfig) {
    this.config = config

    // Register built-in primitives
    this.registerBuiltInPrimitives()

    // Register user-provided primitives
    if (config.primitives) {
      for (const primitive of config.primitives) {
        this.primitives.set(primitive.name, primitive)
      }
    }
  }

  /**
   * Register the built-in primitive capabilities (standard library)
   */
  private registerBuiltInPrimitives(): void {
    // File system primitives
    this.primitives.set(`read_file`, {
      name: `read_file`,
      description: `Read the contents of a file from the filesystem.`,
      parameters: {
        type: `object`,
        properties: {
          path: {
            type: `string`,
            description: `The path to the file to read`,
          },
        },
        required: [`path`],
      },
      execute: async (params) => {
        const fs = await import(`node:fs/promises`)
        const path = params.path as string
        try {
          const content = await fs.readFile(path, `utf-8`)
          return { success: true, content }
        } catch (error) {
          return { success: false, error: (error as Error).message }
        }
      },
    })

    this.primitives.set(`write_file`, {
      name: `write_file`,
      description: `Write content to a file on the filesystem.`,
      parameters: {
        type: `object`,
        properties: {
          path: {
            type: `string`,
            description: `The path to write to`,
          },
          content: {
            type: `string`,
            description: `The content to write`,
          },
        },
        required: [`path`, `content`],
      },
      execute: async (params) => {
        const fs = await import(`node:fs/promises`)
        const path = params.path as string
        const content = params.content as string
        try {
          await fs.writeFile(path, content, `utf-8`)
          return {
            success: true,
            message: `Wrote ${content.length} bytes to ${path}`,
          }
        } catch (error) {
          return { success: false, error: (error as Error).message }
        }
      },
    })

    this.primitives.set(`list_directory`, {
      name: `list_directory`,
      description: `List files and directories in a path.`,
      parameters: {
        type: `object`,
        properties: {
          path: {
            type: `string`,
            description: `The directory path to list`,
          },
        },
        required: [`path`],
      },
      execute: async (params) => {
        const fs = await import(`node:fs/promises`)
        const path = params.path as string
        try {
          const entries = await fs.readdir(path, { withFileTypes: true })
          return {
            success: true,
            entries: entries.map((e) => ({
              name: e.name,
              isDirectory: e.isDirectory(),
              isFile: e.isFile(),
            })),
          }
        } catch (error) {
          return { success: false, error: (error as Error).message }
        }
      },
    })

    // HTTP primitives
    this.primitives.set(`http_fetch`, {
      name: `http_fetch`,
      description: `Make an HTTP request to a URL.`,
      parameters: {
        type: `object`,
        properties: {
          url: {
            type: `string`,
            description: `The URL to fetch`,
          },
          method: {
            type: `string`,
            description: `HTTP method (GET, POST, etc.)`,
          },
          headers: {
            type: `object`,
            description: `HTTP headers to include`,
          },
          body: {
            type: `string`,
            description: `Request body (for POST, PUT, etc.)`,
          },
        },
        required: [`url`],
      },
      execute: async (params) => {
        const url = params.url as string
        const method = (params.method as string | undefined) ?? `GET`
        const headers = params.headers as Record<string, string> | undefined
        const body = params.body as string | undefined

        try {
          const response = await fetch(url, {
            method,
            headers,
            body,
          })
          const text = await response.text()
          return {
            success: true,
            status: response.status,
            statusText: response.statusText,
            headers: Object.fromEntries(response.headers.entries()),
            body: text,
          }
        } catch (error) {
          return { success: false, error: (error as Error).message }
        }
      },
    })

    // Shell/command execution
    this.primitives.set(`execute_command`, {
      name: `execute_command`,
      description: `Execute a shell command. Use with caution.`,
      parameters: {
        type: `object`,
        properties: {
          command: {
            type: `string`,
            description: `The command to execute`,
          },
          cwd: {
            type: `string`,
            description: `Working directory for the command`,
          },
        },
        required: [`command`],
      },
      execute: async (params) => {
        const { exec } = await import(`node:child_process`)
        const { promisify } = await import(`node:util`)
        const execAsync = promisify(exec)

        const command = params.command as string
        const cwd = params.cwd as string | undefined

        try {
          const { stdout, stderr } = await execAsync(command, { cwd })
          return {
            success: true,
            stdout,
            stderr,
          }
        } catch (error) {
          const execError = error as {
            stdout?: string
            stderr?: string
            message: string
          }
          return {
            success: false,
            error: execError.message,
            stdout: execError.stdout,
            stderr: execError.stderr,
          }
        }
      },
    })

    // JSON parsing/manipulation
    this.primitives.set(`parse_json`, {
      name: `parse_json`,
      description: `Parse a JSON string into an object.`,
      parameters: {
        type: `object`,
        properties: {
          json_string: {
            type: `string`,
            description: `The JSON string to parse`,
          },
        },
        required: [`json_string`],
      },
      execute: async (params) => {
        try {
          const parsed = JSON.parse(params.json_string as string)
          return { success: true, data: parsed }
        } catch (error) {
          return { success: false, error: (error as Error).message }
        }
      },
    })

    // Math operations
    this.primitives.set(`calculate`, {
      name: `calculate`,
      description: `Evaluate a mathematical expression.`,
      parameters: {
        type: `object`,
        properties: {
          expression: {
            type: `string`,
            description: `The mathematical expression to evaluate (e.g., '2 + 2 * 3')`,
          },
        },
        required: [`expression`],
      },
      execute: async (params) => {
        const expression = params.expression as string
        // Simple safe evaluation - only allows numbers and basic operators
        const sanitized = expression.replace(/[^0-9+\-*/().%\s]/g, ``)
        if (sanitized !== expression) {
          return {
            success: false,
            error: `Expression contains invalid characters`,
          }
        }
        try {
          // Using Function instead of eval for slightly better sandboxing
          const result = new Function(`return (${sanitized})`)()
          return { success: true, result }
        } catch (error) {
          return { success: false, error: (error as Error).message }
        }
      },
    })

    // Delay/sleep
    this.primitives.set(`delay`, {
      name: `delay`,
      description: `Wait for a specified number of milliseconds.`,
      parameters: {
        type: `object`,
        properties: {
          ms: {
            type: `number`,
            description: `Milliseconds to wait`,
          },
        },
        required: [`ms`],
      },
      execute: async (params) => {
        const ms = Math.min(params.ms as number, 60000) // Max 60 seconds
        await new Promise((resolve) => setTimeout(resolve, ms))
        return { success: true, waited_ms: ms }
      },
    })

    // Current time
    this.primitives.set(`get_current_time`, {
      name: `get_current_time`,
      description: `Get the current date and time.`,
      parameters: {
        type: `object`,
        properties: {},
      },
      execute: async () => {
        const now = new Date()
        return {
          iso: now.toISOString(),
          unix: now.getTime(),
          formatted: now.toLocaleString(),
        }
      },
    })

    // Random number generation
    this.primitives.set(`random`, {
      name: `random`,
      description: `Generate a random number.`,
      parameters: {
        type: `object`,
        properties: {
          min: {
            type: `number`,
            description: `Minimum value (inclusive, default 0)`,
          },
          max: {
            type: `number`,
            description: `Maximum value (exclusive, default 1)`,
          },
          integer: {
            type: `boolean`,
            description: `If true, return an integer`,
          },
        },
      },
      execute: async (params) => {
        const min = (params.min as number | undefined) ?? 0
        const max = (params.max as number | undefined) ?? 1
        const integer = params.integer as boolean | undefined

        let result = Math.random() * (max - min) + min
        if (integer) {
          result = Math.floor(result)
        }
        return { result }
      },
    })
  }

  /**
   * Get a primitive by name
   */
  getPrimitive(name: string): Capability | undefined {
    return this.primitives.get(name)
  }

  /**
   * Create a new prompt object
   */
  async createObject(
    options: CreateObjectOptions
  ): Promise<PromptObjectHandle> {
    const obj = new PromptObject(
      {
        id: options.id,
        name: options.name,
        systemPrompt: options.systemPrompt,
        state: options.state,
        capabilities: options.capabilities,
      },
      this
    )

    this.objects.set(obj.id, obj)

    // Start the object's message listener
    await obj.start()

    return obj
  }

  /**
   * Get an existing object by ID
   */
  getObject(id: string): PromptObjectHandle | undefined {
    return this.objects.get(id)
  }

  /**
   * List all objects
   */
  listObjects(): Array<PromptObjectInfo> {
    return Array.from(this.objects.values()).map((obj) => ({
      id: obj.id,
      name: obj.name,
      capabilities: obj.listCapabilities(),
    }))
  }

  /**
   * Get available primitives
   */
  getAvailablePrimitives(): Array<CapabilityInfo> {
    return Array.from(this.primitives.values()).map((p) => ({
      name: p.name,
      description: p.description,
      parameters: p.parameters,
    }))
  }

  /**
   * Send a message to an object
   */
  async send(
    to: string,
    content: string,
    options?: SendOptions
  ): Promise<void> {
    const obj = this.objects.get(to)

    if (!obj) {
      throw new Error(`No object found with ID: ${to}`)
    }

    const message: Omit<Message, `id` | `timestamp` | `to`> = {
      from: (options?.metadata?.from as string | undefined) ?? `runtime`,
      content,
      metadata: options?.metadata,
    }

    await obj.receive(message)
  }

  /**
   * Send an external message (from outside the system)
   */
  async sendExternal(to: string, content: string): Promise<void> {
    return this.send(to, content, { metadata: { from: `user` } })
  }

  /**
   * Stop all objects
   */
  stop(): void {
    for (const obj of this.objects.values()) {
      obj.stop()
    }
    this.objects.clear()
  }
}
