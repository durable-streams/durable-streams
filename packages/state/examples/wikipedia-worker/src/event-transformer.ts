import { createStateSchema } from "@durable-streams/state"
import { wikipediaEventSchema } from "./types.js"
import type { WikipediaEvent, WikipediaRawEvent } from "./types.js"

// Create state schema for Wikipedia events
export const stateSchema = createStateSchema({
  events: {
    schema: wikipediaEventSchema,
    type: `wikipedia-event`,
    primaryKey: `id`,
  },
})

/**
 * Transforms a raw Wikipedia event from the SSE stream into our standardized format
 * and creates a state protocol insert event.
 */
export function transformWikipediaEvent(
  raw: WikipediaRawEvent
): ReturnType<typeof stateSchema.events.insert> {
  // Extract language from server_name (e.g., "en.wikipedia.org" → "en")
  const language = extractLanguage(raw.server_name)

  // Generate unique composite ID
  // Using server_name, timestamp, and id to ensure uniqueness across wikis
  const id = `${raw.server_name}-${raw.timestamp}-${raw.id}`

  // Compute the event URL for direct Wikipedia links
  const eventUrl = computeEventUrl(raw)

  // Transform to our standardized event format
  const event: WikipediaEvent = {
    id,
    type: raw.type,
    timestamp: new Date(raw.timestamp * 1000).toISOString(),
    user: raw.user,
    isBot: raw.bot,
    namespace: raw.namespace,
    title: raw.title,
    serverName: raw.server_name,
    language,
    lengthOld: raw.length?.old ?? 0,
    lengthNew: raw.length?.new ?? 0,
    revisionId: raw.revision?.new,
    revisionOldId: raw.revision?.old,
    comment: raw.comment || ``,
    eventUrl,
  }

  // Create state protocol insert event
  return stateSchema.events.insert({ value: event })
}

/**
 * Extracts the language code from a Wikipedia server name.
 * Examples:
 *   "en.wikipedia.org" → "en"
 *   "fr.wiktionary.org" → "fr"
 *   "www.wikidata.org" → "wikidata"
 *   "commons.wikimedia.org" → "commons"
 */
function extractLanguage(serverName: string): string {
  const parts = serverName.split(`.`)

  // Handle special cases
  if (serverName === `www.wikidata.org`) return `wikidata`
  if (serverName === `commons.wikimedia.org`) return `commons`
  if (serverName.startsWith(`meta.`)) return `meta`

  // Standard format: "{lang}.{project}.org"
  return parts[0] || `unknown`
}

/**
 * Computes the URL to view the event on Wikipedia.
 * For edits with revisions, returns a diff URL.
 * For other events, returns the page URL.
 */
function computeEventUrl(raw: WikipediaRawEvent): string {
  const protocol = `https://`
  const base = `${protocol}${raw.server_name}/wiki`
  const encodedTitle = encodeURIComponent(raw.title)

  // For edits with revision info, create diff URL
  if (raw.type === `edit` && raw.revision) {
    return `${base}/${encodedTitle}?diff=${raw.revision.new}&oldid=${raw.revision.old}`
  }

  // For new pages with revision, link to that specific revision
  if (raw.type === `new` && raw.revision) {
    return `${base}/${encodedTitle}?oldid=${raw.revision.new}`
  }

  // Default: just link to the page
  return `${base}/${encodedTitle}`
}
