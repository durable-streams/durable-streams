import { z } from "zod"
import { createStateSchema } from "@durable-streams/state"
import type { CollectionDefinition, StateSchema } from "@durable-streams/state"

export const METADATA_COLLECTION_TYPE: `metadata` = `metadata`

const metadataRowSchema = z.discriminatedUnion(`type`, [
  z.object({
    path: z.string(),
    type: z.literal(`file`),
    contentStreamId: z.string(),
    contentType: z.enum([`text`, `binary`]),
    mimeType: z.string(),
    size: z.number(),
    createdAt: z.string(),
    modifiedAt: z.string(),
  }),
  z.object({
    path: z.string(),
    type: z.literal(`directory`),
    createdAt: z.string(),
    modifiedAt: z.string(),
  }),
])

type MetadataRow =
  | {
      path: string
      type: `file`
      contentStreamId: string
      contentType: `text` | `binary`
      mimeType: string
      size: number
      createdAt: string
      modifiedAt: string
    }
  | {
      path: string
      type: `directory`
      createdAt: string
      modifiedAt: string
    }

type MetadataCollections = {
  metadata: CollectionDefinition<MetadataRow>
}

export const metadataStateSchema: StateSchema<MetadataCollections> =
  createStateSchema({
    metadata: {
      schema: metadataRowSchema,
      type: METADATA_COLLECTION_TYPE,
      primaryKey: `path`,
    },
  })
