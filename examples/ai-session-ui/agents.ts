/**
 * Agent configurations using Anthropic SDK directly
 */

import type Anthropic from "@anthropic-ai/sdk"
import * as fs from "fs"
import * as path from "path"

// Tool executor type - function that runs the tool
export type ToolExecutor = (input: Record<string, unknown>) => Promise<string>

// =============================================================================
// Filesystem Agent Tools
// =============================================================================

const basePath = process.cwd()

// Anthropic tool definitions (for API) + executors (for running)
export interface ToolDefinition {
  schema: Anthropic.Tool
  execute: ToolExecutor
}

export const filesystemTools: Record<string, ToolDefinition> = {
  list_directory: {
    schema: {
      name: "list_directory",
      description: "List files and directories in a given path. Returns file names with indicators for directories (/).",
      input_schema: {
        type: "object" as const,
        properties: {
          path: { type: "string", description: "The directory path to list. Use '.' for current directory." },
        },
        required: ["path"],
      },
    },
    execute: async (input) => {
      const dirPath = input.path as string
      const fullPath = path.resolve(basePath, dirPath)
      try {
        const entries = fs.readdirSync(fullPath, { withFileTypes: true })
        const result = entries
          .slice(0, 50)
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
          .join("\n")
        return result || "(empty directory)"
      } catch (err) {
        return `Error: ${(err as Error).message}`
      }
    },
  },

  read_file: {
    schema: {
      name: "read_file",
      description: "Read the contents of a file. Returns the file content as text.",
      input_schema: {
        type: "object" as const,
        properties: {
          path: { type: "string", description: "The file path to read." },
          max_lines: { type: "number", description: "Maximum number of lines to read. Defaults to 100." },
        },
        required: ["path"],
      },
    },
    execute: async (input) => {
      const filePath = input.path as string
      const maxLines = (input.max_lines as number) || 100
      const fullPath = path.resolve(basePath, filePath)
      try {
        const content = fs.readFileSync(fullPath, "utf-8")
        const lines = content.split("\n").slice(0, maxLines)
        if (content.split("\n").length > maxLines) {
          lines.push(`\n... (truncated at ${maxLines} lines)`)
        }
        return lines.join("\n")
      } catch (err) {
        return `Error: ${(err as Error).message}`
      }
    },
  },

  search_files: {
    schema: {
      name: "search_files",
      description: "Search for files matching a pattern in a directory.",
      input_schema: {
        type: "object" as const,
        properties: {
          directory: { type: "string", description: "The directory to search in." },
          pattern: { type: "string", description: "The glob pattern to match (e.g., '*.ts', '*.md')." },
        },
        required: ["directory", "pattern"],
      },
    },
    execute: async (input) => {
      const directory = input.directory as string
      const pattern = input.pattern as string
      const dirPath = path.resolve(basePath, directory)
      try {
        const results: string[] = []
        const searchDir = (dir: string, depth = 0) => {
          if (depth > 3 || results.length > 20) return
          const entries = fs.readdirSync(dir, { withFileTypes: true })
          for (const entry of entries) {
            if (entry.name.startsWith(".") || entry.name === "node_modules") continue
            const entryPath = path.join(dir, entry.name)
            if (entry.isDirectory()) {
              searchDir(entryPath, depth + 1)
            } else if (matchGlob(entry.name, pattern)) {
              results.push(path.relative(basePath, entryPath))
            }
          }
        }
        searchDir(dirPath)
        return results.length > 0 ? results.join("\n") : "No files found"
      } catch (err) {
        return `Error: ${(err as Error).message}`
      }
    },
  },
}

function matchGlob(filename: string, pattern: string): boolean {
  const regex = new RegExp(
    "^" + pattern.replace(/\*/g, ".*").replace(/\?/g, ".") + "$"
  )
  return regex.test(filename)
}

// =============================================================================
// API Agent Tools
// =============================================================================

export const apiTools: Record<string, ToolDefinition> = {
  fetch_weather: {
    schema: {
      name: "fetch_weather",
      description: "Get current weather for a location using Open-Meteo API (free, no key required).",
      input_schema: {
        type: "object" as const,
        properties: {
          latitude: { type: "number", description: "Latitude of the location." },
          longitude: { type: "number", description: "Longitude of the location." },
          location_name: { type: "string", description: "Human-readable name of the location." },
        },
        required: ["latitude", "longitude"],
      },
    },
    execute: async (input) => {
      const latitude = input.latitude as number
      const longitude = input.longitude as number
      const locationName = input.location_name as string | undefined
      try {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,wind_speed_10m,weather_code&temperature_unit=fahrenheit`
        const res = await fetch(url)
        const data = await res.json()
        const current = data.current
        const weatherDesc = getWeatherDescription(current.weather_code)
        return `Weather in ${locationName || `${latitude}, ${longitude}`}:
Temperature: ${current.temperature_2m}°F
Wind Speed: ${current.wind_speed_10m} km/h
Conditions: ${weatherDesc}`
      } catch (err) {
        return `Error fetching weather: ${(err as Error).message}`
      }
    },
  },

  fetch_wikipedia: {
    schema: {
      name: "fetch_wikipedia",
      description: "Search Wikipedia and get a summary of an article.",
      input_schema: {
        type: "object" as const,
        properties: {
          query: { type: "string", description: "The search query or article title." },
        },
        required: ["query"],
      },
    },
    execute: async (input) => {
      const query = input.query as string
      try {
        const searchUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}`
        const res = await fetch(searchUrl)
        if (!res.ok) {
          return `No Wikipedia article found for "${query}"`
        }
        const data = await res.json()
        return `**${data.title}**\n\n${data.extract}`
      } catch (err) {
        return `Error fetching Wikipedia: ${(err as Error).message}`
      }
    },
  },

  fetch_hackernews: {
    schema: {
      name: "fetch_hackernews",
      description: "Get top stories from Hacker News.",
      input_schema: {
        type: "object" as const,
        properties: {
          count: { type: "number", description: "Number of stories to fetch (max 10). Defaults to 5." },
        },
        required: [],
      },
    },
    execute: async (input) => {
      const count = (input.count as number) || 5
      const limit = Math.min(count, 10)
      try {
        const topStoriesRes = await fetch(
          "https://hacker-news.firebaseio.com/v0/topstories.json"
        )
        const storyIds = (await topStoriesRes.json()).slice(0, limit)

        const stories = await Promise.all(
          storyIds.map(async (id: number) => {
            const res = await fetch(
              `https://hacker-news.firebaseio.com/v0/item/${id}.json`
            )
            return res.json()
          })
        )

        return stories
          .map(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (s: any, i: number) =>
              `${i + 1}. ${s.title}\n   ${s.url || "(no url)"}\n   ${s.score} points`
          )
          .join("\n\n")
      } catch (err) {
        return `Error fetching Hacker News: ${(err as Error).message}`
      }
    },
  },
}

function getWeatherDescription(code: number): string {
  const descriptions: Record<number, string> = {
    0: "Clear sky",
    1: "Mainly clear",
    2: "Partly cloudy",
    3: "Overcast",
    45: "Foggy",
    48: "Depositing rime fog",
    51: "Light drizzle",
    53: "Moderate drizzle",
    55: "Dense drizzle",
    61: "Slight rain",
    63: "Moderate rain",
    65: "Heavy rain",
    71: "Slight snow",
    73: "Moderate snow",
    75: "Heavy snow",
    80: "Slight rain showers",
    81: "Moderate rain showers",
    82: "Violent rain showers",
    95: "Thunderstorm",
  }
  return descriptions[code] || `Weather code ${code}`
}

// =============================================================================
// Agent Configurations
// =============================================================================

export interface AgentConfig {
  id: string
  name: string
  model: string
  systemPrompt: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: Record<string, any>
}

export const agents: Record<string, AgentConfig> = {
  filesystem: {
    id: "filesystem",
    name: "File Explorer",
    model: "claude-sonnet-4-5-20250929",
    systemPrompt: `You are a helpful file system assistant. You can explore directories, read files, and search for files.

When asked about files or code:
1. First use list_directory to understand the structure
2. Use search_files to find relevant files
3. Use read_file to examine contents
4. Summarize what you find in a helpful way

Keep responses concise but informative. If you find code, explain what it does briefly.`,
    tools: filesystemTools,
  },
  api: {
    id: "api",
    name: "Web Explorer",
    model: "claude-sonnet-4-5-20250929",
    systemPrompt: `You are a helpful assistant that can fetch information from the web.

You have access to:
- Weather data (Open-Meteo API)
- Wikipedia articles
- Hacker News top stories

Use these tools to answer questions about current events, weather, or to look up information.
Present the information in a clear, conversational way.`,
    tools: apiTools,
  },
}
