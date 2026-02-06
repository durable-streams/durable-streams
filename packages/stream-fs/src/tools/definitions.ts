/**
 * LLM Tool Definitions for Stream-FS
 *
 * Tool definitions compatible with Claude's function calling.
 */

import type { Tool } from "@anthropic-ai/sdk/resources/messages"

export const streamFsTools: Array<Tool> = [
  {
    name: `read_file`,
    description: `Read the contents of a file. Returns the file content as text.`,
    input_schema: {
      type: `object` as const,
      properties: {
        path: {
          type: `string`,
          description: `The path to the file to read (e.g., "/docs/readme.md")`,
        },
      },
      required: [`path`],
    },
  },
  {
    name: `write_file`,
    description: `Replace the entire contents of an existing file with new content. Use this for complete file overwrites.`,
    input_schema: {
      type: `object` as const,
      properties: {
        path: {
          type: `string`,
          description: `The path to the file to write (e.g., "/docs/readme.md")`,
        },
        content: {
          type: `string`,
          description: `The new content for the file`,
        },
      },
      required: [`path`, `content`],
    },
  },
  {
    name: `create_file`,
    description: `Create a new file with the specified content. Fails if the file already exists.`,
    input_schema: {
      type: `object` as const,
      properties: {
        path: {
          type: `string`,
          description: `The path for the new file (e.g., "/docs/readme.md")`,
        },
        content: {
          type: `string`,
          description: `The initial content for the file`,
        },
        mime_type: {
          type: `string`,
          description: `Optional MIME type (e.g., "text/markdown"). If not provided, will be auto-detected from the file extension.`,
        },
      },
      required: [`path`, `content`],
    },
  },
  {
    name: `delete_file`,
    description: `Delete a file. Fails if the path is a directory.`,
    input_schema: {
      type: `object` as const,
      properties: {
        path: {
          type: `string`,
          description: `The path to the file to delete (e.g., "/docs/readme.md")`,
        },
      },
      required: [`path`],
    },
  },
  {
    name: `edit_file`,
    description: `Edit a file by finding and replacing a string. The old_str must appear exactly once in the file. Returns an error if the string is not found or appears multiple times.`,
    input_schema: {
      type: `object` as const,
      properties: {
        path: {
          type: `string`,
          description: `The path to the file to edit (e.g., "/src/main.ts")`,
        },
        old_str: {
          type: `string`,
          description: `The exact string to find and replace. Must appear exactly once in the file.`,
        },
        new_str: {
          type: `string`,
          description: `The string to replace old_str with`,
        },
      },
      required: [`path`, `old_str`, `new_str`],
    },
  },
  {
    name: `list_directory`,
    description: `List the contents of a directory. Returns a list of files and subdirectories with their sizes and modification times.`,
    input_schema: {
      type: `object` as const,
      properties: {
        path: {
          type: `string`,
          description: `The path to the directory to list (e.g., "/docs" or "/")`,
        },
      },
      required: [`path`],
    },
  },
  {
    name: `mkdir`,
    description: `Create a new directory. The parent directory must exist.`,
    input_schema: {
      type: `object` as const,
      properties: {
        path: {
          type: `string`,
          description: `The path for the new directory (e.g., "/docs/images")`,
        },
      },
      required: [`path`],
    },
  },
  {
    name: `rmdir`,
    description: `Remove an empty directory. Fails if the directory is not empty.`,
    input_schema: {
      type: `object` as const,
      properties: {
        path: {
          type: `string`,
          description: `The path to the directory to remove (e.g., "/docs/old")`,
        },
      },
      required: [`path`],
    },
  },
  {
    name: `exists`,
    description: `Check if a file or directory exists at the given path.`,
    input_schema: {
      type: `object` as const,
      properties: {
        path: {
          type: `string`,
          description: `The path to check (e.g., "/docs/readme.md")`,
        },
      },
      required: [`path`],
    },
  },
  {
    name: `stat`,
    description: `Get metadata about a file or directory, including type, size, creation time, and modification time.`,
    input_schema: {
      type: `object` as const,
      properties: {
        path: {
          type: `string`,
          description: `The path to get stats for (e.g., "/docs/readme.md")`,
        },
      },
      required: [`path`],
    },
  },
]

export type StreamFsToolName =
  | `read_file`
  | `write_file`
  | `create_file`
  | `delete_file`
  | `edit_file`
  | `list_directory`
  | `mkdir`
  | `rmdir`
  | `exists`
  | `stat`

const TOOL_NAMES = new Set<string>(streamFsTools.map((t) => t.name))

export function isStreamFsTool(name: string): name is StreamFsToolName {
  return TOOL_NAMES.has(name)
}
