export interface ParsedWriteArgs {
  contentType: string
  content: string
  batchJson: boolean
}

/**
 * Parse write command arguments, extracting content-type flags and content.
 * @param args - Arguments after the stream_id (starting from index 2)
 * @returns Parsed content type and content string
 * @throws Error if --content-type is missing its value or if unknown flags are provided
 */
export function parseWriteArgs(args: Array<string>): ParsedWriteArgs {
  let contentType = `application/octet-stream`
  let batchJson = false
  const contentParts: Array<string> = []

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!

    if (arg === `--json`) {
      contentType = `application/json`
      continue
    }

    if (arg === `--batch-json`) {
      batchJson = true
      contentType = `application/json`
      continue
    }

    if (arg === `--content-type`) {
      const nextArg = args[i + 1]
      if (!nextArg || nextArg.startsWith(`--`)) {
        throw new Error(`--content-type requires a value`)
      }
      contentType = nextArg
      i++
      continue
    }

    if (arg.startsWith(`--`)) {
      throw new Error(`unknown flag: ${arg}`)
    }

    contentParts.push(arg)
  }

  return {
    contentType,
    content: contentParts.join(` `),
    batchJson,
  }
}
