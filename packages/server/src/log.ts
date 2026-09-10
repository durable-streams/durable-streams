const streamsLogFile = process.env.STREAMS_LOG_FILE

async function appendLogLine(line: string): Promise<void> {
  if (!streamsLogFile) return
  const fs = await import(`node:fs/promises`)
  const path = await import(`node:path`)
  await fs.mkdir(path.dirname(streamsLogFile), { recursive: true })
  await fs.appendFile(streamsLogFile, `${line}\n`)
}

function serializeArg(arg: unknown): string {
  if (arg instanceof Error) {
    return arg.stack ?? arg.message
  }
  if (typeof arg === `string`) {
    return arg
  }
  try {
    return JSON.stringify(arg)
  } catch {
    return String(arg)
  }
}

function write(level: `info` | `warn` | `error`, args: Array<unknown>): void {
  const line = args.map(serializeArg).join(` `)
  const formatted = `[${level}] ${line}`

  if (level === `error`) {
    console.error(formatted)
  } else if (level === `warn`) {
    console.warn(formatted)
  } else {
    console.info(formatted)
  }

  void appendLogLine(formatted).catch(() => undefined)
}

export const serverLog = {
  info(...args: Array<unknown>): void {
    write(`info`, args)
  },

  warn(...args: Array<unknown>): void {
    write(`warn`, args)
  },

  error(...args: Array<unknown>): void {
    write(`error`, args)
  },

  event(obj: Record<string, unknown>, msg: string): void {
    write(`info`, [msg, obj])
  },
}
