import { Type } from "@sinclair/typebox"

const BRAVE_API_URL = `https://api.search.brave.com/res/v1/web/search`

export const webSearchTool = {
  name: `web_search`,
  label: `Web Search`,
  description: `Search the web for current information. Returns titles, URLs, and snippets from top results.`,
  parameters: Type.Object({
    query: Type.String({ description: `The search query` }),
  }),
  execute: async (
    _toolCallId: string,
    params: { query: string }
  ): Promise<{
    content: Array<{ type: `text`; text: string }>
    details: { resultCount: number }
  }> => {
    const apiKey = process.env.BRAVE_SEARCH_API_KEY
    if (!apiKey) {
      return {
        content: [
          {
            type: `text` as const,
            text: `Error: BRAVE_SEARCH_API_KEY not configured`,
          },
        ],
        details: { resultCount: 0 },
      }
    }

    const url = `${BRAVE_API_URL}?q=${encodeURIComponent(params.query)}&count=5`
    const res = await fetch(url, {
      headers: { "X-Subscription-Token": apiKey },
    })

    if (!res.ok) {
      return {
        content: [
          {
            type: `text` as const,
            text: `Search failed: ${res.status} ${res.statusText}`,
          },
        ],
        details: { resultCount: 0 },
      }
    }

    const data = (await res.json()) as {
      web?: {
        results?: Array<{ title: string; url: string; description: string }>
      }
    }
    const results = data.web?.results ?? []

    if (results.length === 0) {
      return {
        content: [
          {
            type: `text` as const,
            text: `No results found for "${params.query}"`,
          },
        ],
        details: { resultCount: 0 },
      }
    }

    const formatted = results
      .map(
        (r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.description}`
      )
      .join(`\n\n`)

    return {
      content: [{ type: `text` as const, text: formatted }],
      details: { resultCount: results.length },
    }
  },
}
