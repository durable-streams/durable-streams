import { z } from "zod"

// Raw Wikipedia event from SSE stream
export interface WikipediaRawEvent {
  $schema: string
  meta: {
    uri: string
    request_id?: string
    id: string
    dt: string
    domain: string
    stream: string
    topic?: string
    partition?: number
    offset?: number
  }
  id?: number
  type: `edit` | `log` | `new` | `categorize`
  namespace: number
  title: string
  title_url?: string
  comment?: string
  timestamp: number
  user: string
  bot: boolean
  minor?: boolean
  patrolled?: boolean
  length?: {
    old: number
    new: number
  }
  revision?: {
    old: number
    new: number
  }
  server_url: string
  server_name: string
  server_script_path: string
  wiki: string
  parsedcomment?: string
  log_id?: number
  log_type?: string
  log_action?: string
  log_params?: unknown
  log_action_comment?: string
  notify_url?: string
}

// Zod schema for our transformed events (matches client schema)
export const wikipediaEventSchema: z.ZodObject<{
  id: z.ZodString
  type: z.ZodEnum<[`edit`, `log`, `new`, `categorize`]>
  timestamp: z.ZodString
  user: z.ZodString
  isBot: z.ZodBoolean
  namespace: z.ZodNumber
  title: z.ZodString
  serverName: z.ZodString
  language: z.ZodString
  lengthOld: z.ZodNumber
  lengthNew: z.ZodNumber
  revisionId: z.ZodOptional<z.ZodNumber>
  revisionOldId: z.ZodOptional<z.ZodNumber>
  comment: z.ZodString
  eventUrl: z.ZodString
}> = z.object({
  id: z.string(),
  type: z.enum([`edit`, `log`, `new`, `categorize`]),
  timestamp: z.string(),
  user: z.string(),
  isBot: z.boolean(),
  namespace: z.number(),
  title: z.string(),
  serverName: z.string(),
  language: z.string(),
  lengthOld: z.number(),
  lengthNew: z.number(),
  revisionId: z.number().optional(),
  revisionOldId: z.number().optional(),
  comment: z.string(),
  eventUrl: z.string(),
})

export type WikipediaEvent = z.infer<typeof wikipediaEventSchema>
