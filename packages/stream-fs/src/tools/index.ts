/**
 * Stream-FS LLM Tools
 *
 * Tools for Claude's function calling to interact with DurableFilesystem.
 */

export {
  streamFsTools,
  isStreamFsTool,
  type StreamFsToolName,
} from "./definitions"
export { handleTool, type ToolResult, type ToolInput } from "./handlers"
export type {
  ReadFileInput,
  WriteFileInput,
  CreateFileInput,
  DeleteFileInput,
  EditFileInput,
  ListDirectoryInput,
  MkdirInput,
  RmdirInput,
  ExistsInput,
  StatInput,
} from "./handlers"
