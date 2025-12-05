/**
 * File manager for stream storage operations.
 * Handles directory creation, deletion, and listing for stream data files.
 */

import * as fs from "node:fs/promises"
import * as path from "node:path"
import { decodeStreamPath, encodeStreamPath } from "./path-encoding"

export class StreamFileManager {
  constructor(private streamsDir: string) {}

  /**
   * Create a directory for a new stream and initialize the first segment file.
   * Returns the absolute path to the stream directory.
   */
  async createStreamDirectory(streamPath: string): Promise<string> {
    const encoded = encodeStreamPath(streamPath)
    const dir = path.join(this.streamsDir, encoded)
    await fs.mkdir(dir, { recursive: true })

    // Create initial segment file (empty)
    const segmentPath = path.join(dir, `segment_00000.log`)
    await fs.writeFile(segmentPath, ``)

    return dir
  }

  /**
   * Delete a stream directory and all its contents.
   */
  async deleteStreamDirectory(streamPath: string): Promise<void> {
    const encoded = encodeStreamPath(streamPath)
    const dir = path.join(this.streamsDir, encoded)
    await fs.rm(dir, { recursive: true, force: true })
  }

  /**
   * Delete a directory by its exact name (used for unique directory names).
   */
  async deleteDirectoryByName(directoryName: string): Promise<void> {
    const dir = path.join(this.streamsDir, directoryName)
    await fs.rm(dir, { recursive: true, force: true })
  }

  /**
   * Get the absolute path to a stream's directory.
   * Returns null if the directory doesn't exist.
   */
  async getStreamDirectory(streamPath: string): Promise<string | null> {
    const encoded = encodeStreamPath(streamPath)
    const dir = path.join(this.streamsDir, encoded)

    try {
      await fs.access(dir)
      return dir
    } catch {
      return null
    }
  }

  /**
   * List all stream paths by scanning the streams directory.
   */
  async listStreamPaths(): Promise<Array<string>> {
    try {
      const entries = await fs.readdir(this.streamsDir, {
        withFileTypes: true,
      })
      return entries
        .filter((e) => e.isDirectory())
        .map((e) => decodeStreamPath(e.name))
    } catch {
      // Directory doesn't exist yet - return empty array
      return []
    }
  }

  /**
   * Get the path to a segment file within a stream directory.
   *
   * @param streamDir - Absolute path to the stream directory
   * @param index - Segment index (0-based)
   */
  getSegmentPath(streamDir: string, index: number): string {
    const paddedIndex = String(index).padStart(5, `0`)
    return path.join(streamDir, `segment_${paddedIndex}.log`)
  }
}
