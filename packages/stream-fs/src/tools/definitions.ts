/**
 * LLM Tool Definitions for Stream-FS
 *
 * Tool definitions compatible with Claude's function calling.
 */

import type { Tool } from "@anthropic-ai/sdk/resources/messages"

export const streamFsTools: Array<Tool> = [
  {
    name: `read_file`,
    description: `Read the contents of a file. Returns the file content as text with line metadata. Supports pagination via offset/limit for large files.`,
    input_schema: {
      type: `object` as const,
      properties: {
        path: {
          type: `string`,
          description: `The path to the file to read (e.g., "/docs/readme.md")`,
        },
        offset: {
          type: `integer`,
          description: `0-based line number to start reading from. Defaults to 0.`,
        },
        limit: {
          type: `integer`,
          description: `Maximum number of lines to return. Defaults to all lines.`,
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
    description: `Edit a file by finding and replacing strings. Supports two modes:
1. Single edit: provide old_str and new_str at the top level.
2. Batch edit: provide an edits array of {old_str, new_str} pairs to make multiple changes at once.
Each old_str must appear exactly once in the file. Returns an error if any string is not found or appears multiple times.`,
    input_schema: {
      type: `object` as const,
      properties: {
        path: {
          type: `string`,
          description: `The path to the file to edit (e.g., "/src/main.ts")`,
        },
        old_str: {
          type: `string`,
          description: `The exact string to find and replace. Must appear exactly once in the file. Use this for single edits.`,
        },
        new_str: {
          type: `string`,
          description: `The string to replace old_str with. Required when old_str is provided.`,
        },
        edits: {
          type: `array`,
          description: `An array of edits to apply. Use this for batch edits instead of old_str/new_str. Each edit's old_str must appear exactly once in the file.`,
          items: {
            type: `object`,
            properties: {
              old_str: {
                type: `string`,
                description: `The exact string to find and replace`,
              },
              new_str: {
                type: `string`,
                description: `The string to replace old_str with`,
              },
            },
            required: [`old_str`, `new_str`],
          },
        },
      },
      required: [`path`],
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
  {
    name: `append_file`,
    description: `Append content to the end of an existing file. Creates a newline separator if the file doesn't end with one.`,
    input_schema: {
      type: `object` as const,
      properties: {
        path: {
          type: `string`,
          description: `The path to the file to append to (e.g., "/logs/output.log")`,
        },
        content: {
          type: `string`,
          description: `The content to append to the file`,
        },
      },
      required: [`path`, `content`],
    },
  },
  {
    name: `move`,
    description: `Move or rename a file or directory. The destination parent directory must exist.`,
    input_schema: {
      type: `object` as const,
      properties: {
        source: {
          type: `string`,
          description: `The current path of the file or directory (e.g., "/old/location.txt")`,
        },
        destination: {
          type: `string`,
          description: `The new path for the file or directory (e.g., "/new/location.txt")`,
        },
      },
      required: [`source`, `destination`],
    },
  },
  {
    name: `copy`,
    description: `Copy a file to a new location. Only works with files, not directories.`,
    input_schema: {
      type: `object` as const,
      properties: {
        source: {
          type: `string`,
          description: `The path of the file to copy (e.g., "/docs/readme.md")`,
        },
        destination: {
          type: `string`,
          description: `The path for the copy (e.g., "/docs/readme-backup.md")`,
        },
      },
      required: [`source`, `destination`],
    },
  },
  {
    name: `tree`,
    description: `List all files and directories recursively. Returns a flat list of all paths with their types and sizes.`,
    input_schema: {
      type: `object` as const,
      properties: {
        path: {
          type: `string`,
          description: `The root path to start from (defaults to "/")`,
        },
        depth: {
          type: `integer`,
          description: `Maximum recursion depth. Omit for unlimited depth.`,
        },
      },
      required: [],
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
  | `append_file`
  | `move`
  | `copy`
  | `tree`

const TOOL_NAMES = new Set<string>(streamFsTools.map((t) => t.name))

export function isStreamFsTool(name: string): name is StreamFsToolName {
  return TOOL_NAMES.has(name)
}
