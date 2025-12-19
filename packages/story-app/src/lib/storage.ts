/**
 * Storage helpers for story progress persistence
 *
 * Uses sessionStorage to save/restore story playback state
 * This survives page refresh but not tab close
 */

export interface StoryProgress {
  offset: string // Stream offset for resuming subscription
  audioTimestamp: number // Audio playback position in seconds
  title: string | null
  prompt: string | null
  finished: boolean
}

const STORAGE_KEY_PREFIX = "story-progress-"

/**
 * Save story progress to sessionStorage
 */
export function saveStoryProgress(
  streamId: string,
  progress: StoryProgress
): void {
  try {
    const key = STORAGE_KEY_PREFIX + streamId
    sessionStorage.setItem(key, JSON.stringify(progress))
  } catch {
    // Ignore storage errors (e.g., quota exceeded, private browsing)
    console.warn("Failed to save story progress to sessionStorage")
  }
}

/**
 * Load story progress from sessionStorage
 */
export function loadStoryProgress(streamId: string): StoryProgress | null {
  try {
    const key = STORAGE_KEY_PREFIX + streamId
    const data = sessionStorage.getItem(key)
    if (data) {
      return JSON.parse(data) as StoryProgress
    }
  } catch {
    // Ignore parse errors
    console.warn("Failed to load story progress from sessionStorage")
  }
  return null
}

/**
 * Clear story progress from sessionStorage
 */
export function clearStoryProgress(streamId: string): void {
  try {
    const key = STORAGE_KEY_PREFIX + streamId
    sessionStorage.removeItem(key)
  } catch {
    // Ignore errors
  }
}
