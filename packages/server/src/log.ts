import fs from "node:fs"
import path from "node:path"
import pino from "pino"

const prettyTransport = {
  target: `pino-pretty`,
  options: {
    colorize: true,
    ignore: `pid,hostname,name`,
    translateTime: `SYS:HH:MM:ss`,
  },
}

const streamsLogFile = process.env.STREAMS_LOG_FILE

function buildTransport():
  | pino.TransportSingleOptions
  | pino.TransportMultiOptions {
  if (!streamsLogFile) return prettyTransport

  fs.mkdirSync(path.dirname(streamsLogFile), { recursive: true })
  return {
    targets: [
      prettyTransport,
      {
        target: `pino/file`,
        options: { destination: streamsLogFile, mkdir: true },
        level: `info`,
      },
    ],
  }
}

const logger = pino({ transport: buildTransport() })

function formatArgs(args: Array<unknown>): { err?: Error; msg: string } {
  const errors: Array<Error> = []
  const parts: Array<string> = []
  for (const a of args) {
    if (a instanceof Error) errors.push(a)
    else parts.push(typeof a === `string` ? a : JSON.stringify(a))
  }
  return {
    err: errors[0],
    msg: parts.join(` `),
  }
}

export const serverLog = {
  info(...args: Array<unknown>): void {
    const { msg } = formatArgs(args)
    logger.info(msg)
  },

  warn(...args: Array<unknown>): void {
    const { err, msg } = formatArgs(args)
    if (err) logger.warn({ err }, msg)
    else logger.warn(msg)
  },

  error(...args: Array<unknown>): void {
    const { err, msg } = formatArgs(args)
    if (err) logger.error({ err }, msg)
    else logger.error(msg)
  },

  event(obj: Record<string, unknown>, msg: string): void {
    logger.info(obj, msg)
  },
}
