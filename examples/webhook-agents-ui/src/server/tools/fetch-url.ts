import { Type } from "@sinclair/typebox"
import Anthropic from "@anthropic-ai/sdk"

const MAX_RAW_CHARS = 80_000

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ``)
    .replace(/<style[\s\S]*?<\/style>/gi, ``)
    .replace(/<nav[\s\S]*?<\/nav>/gi, ``)
    .replace(/<footer[\s\S]*?<\/footer>/gi, ``)
    .replace(/<header[\s\S]*?<\/header>/gi, ``)
    .replace(
      /<\/?(p|div|br|h[1-6]|li|tr|blockquote|section|article)[^>]*>/gi,
      `\n`
    )
    .replace(/<[^>]+>/g, ``)
    .replace(/&amp;/g, `&`)
    .replace(/&lt;/g, `<`)
    .replace(/&gt;/g, `>`)
    .replace(/&quot;/g, `"`)
    .replace(/&#39;/g, `'`)
    .replace(/&nbsp;/g, ` `)
    .replace(/[ \t]+/g, ` `)
    .replace(/\n{3,}/g, `\n\n`)
    .trim()
}

let anthropic: Anthropic | null = null
function getClient(): Anthropic {
  if (!anthropic) {
    anthropic = new Anthropic()
  }
  return anthropic
}

async function extractWithLLM(text: string, prompt: string): Promise<string> {
  const client = getClient()
  const res = await client.messages.create({
    model: `claude-haiku-4-5-20251001`,
    max_tokens: 2048,
    messages: [
      {
        role: `user`,
        content: `${prompt}\n\n<page_content>\n${text.slice(0, MAX_RAW_CHARS)}\n</page_content>`,
      },
    ],
  })
  const block = res.content[0]
  return block.type === `text` ? block.text : ``
}

export const fetchUrlTool = {
  name: `fetch_url`,
  label: `Fetch URL`,
  description: `Fetch a web page and extract its key content using AI. Provide a prompt describing what information you want from the page. Returns a focused extraction rather than raw HTML.`,
  parameters: Type.Object({
    url: Type.String({ description: `The URL to fetch` }),
    prompt: Type.String({
      description: `What to extract from the page, e.g. 'Extract the main article content' or 'Find the pricing information'`,
    }),
  }),
  execute: async (
    _toolCallId: string,
    params: { url: string; prompt: string }
  ): Promise<{
    content: Array<{ type: `text`; text: string }>
    details: { charCount: number; usedLLM: boolean }
  }> => {
    try {
      const res = await fetch(params.url, {
        headers: {
          "User-Agent": `Mozilla/5.0 (compatible; DurableStreamsAgent/1.0)`,
          Accept: `text/html,application/xhtml+xml,text/plain,*/*`,
        },
        redirect: `follow`,
        signal: AbortSignal.timeout(10_000),
      })

      if (!res.ok) {
        return {
          content: [
            {
              type: `text` as const,
              text: `Failed to fetch: ${res.status} ${res.statusText}`,
            },
          ],
          details: { charCount: 0, usedLLM: false },
        }
      }

      const contentType = res.headers.get(`content-type`) ?? ``
      const raw = await res.text()
      const text = contentType.includes(`text/html`) ? htmlToText(raw) : raw

      const extracted = await extractWithLLM(text, params.prompt)

      return {
        content: [{ type: `text` as const, text: extracted }],
        details: { charCount: extracted.length, usedLLM: true },
      }
    } catch (err) {
      return {
        content: [
          {
            type: `text` as const,
            text: `Error fetching URL: ${err instanceof Error ? err.message : `Unknown error`}`,
          },
        ],
        details: { charCount: 0, usedLLM: false },
      }
    }
  },
}
