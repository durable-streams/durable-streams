import { z } from "zod"

// Zod schema for Wikipedia events (matches worker schema)
export const wikipediaEventSchema = z.object({
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

// Filter state
export interface Filters {
  languages: Set<string>
  types: Set<string>
  showBots: boolean
  namespaces: Set<number>
}

// Namespace definitions for filtering
export const NAMESPACES = [
  { id: 0, name: `Article` },
  { id: 1, name: `Talk` },
  { id: 2, name: `User` },
  { id: 3, name: `User talk` },
  { id: 4, name: `Wikipedia` },
  { id: 5, name: `Wikipedia talk` },
  { id: 6, name: `File` },
  { id: 7, name: `File talk` },
  { id: 10, name: `Template` },
  { id: 11, name: `Template talk` },
  { id: 14, name: `Category` },
  { id: 15, name: `Category talk` },
] as const
