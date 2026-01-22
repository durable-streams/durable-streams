export interface ParsedWriteArgs {
  contentType: string
  content: string
  batchJson: boolean
}

/**
 * Extract a flag value from args, supporting both --flag=value and --flag value syntax.
 * Returns { value, consumed } where consumed is the number of args used (0 if no match).
 */
function extractFlagValue(
  args: Array<string>,
  index: number,
  flagName: string
): { value: string | null; consumed: number } {
  const arg = args[index]!
  const prefix = `${flagName}=`

  if (arg.startsWith(prefix)) {
    const value = arg.slice(prefix.length)
    if (!value) {
      throw new Error(`${flagName} requires a value`)
    }
    return { value, consumed: 1 }
  }

  if (arg === flagName) {
    const value = args[index + 1]
    if (!value || value.startsWith(`--`)) {
      throw new Error(`${flagName} requires a value`)
    }
    return { value, consumed: 2 }
  }

  return { value: null, consumed: 0 }
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

    const contentTypeResult = extractFlagValue(args, i, `--content-type`)
    if (contentTypeResult.value !== null) {
      contentType = contentTypeResult.value
      i += contentTypeResult.consumed - 1
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
