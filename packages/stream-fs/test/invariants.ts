/**
 * Invariant Checkers for Stream-FS
 *
 * These functions verify that the filesystem state satisfies the invariants
 * defined in SPEC.md. Each checker is sound (no false positives) and returns
 * a detailed result.
 */

import { dirname, normalizePath } from "../src/utils"
import type { DurableFilesystem } from "../src/filesystem"
import type {
  FilesystemSnapshot,
  HistoryEvent,
  InvariantCheckResult,
} from "./dsl/types"

// I1: Path Normalization Idempotence

export function checkPathNormalizationIdempotence(
  paths: Array<string>
): InvariantCheckResult {
  for (const path of paths) {
    const once = normalizePath(path)
    const twice = normalizePath(once)
    if (once !== twice) {
      return {
        invariant: `I1: Path Normalization Idempotence`,
        passed: false,
        message: `normalize(normalize("${path}")) !== normalize("${path}")`,
        details: { path, once, twice },
      }
    }
  }
  return { invariant: `I1: Path Normalization Idempotence`, passed: true }
}

// I2: Canonical Path Form

export function checkCanonicalPathForm(
  paths: Array<string>
): InvariantCheckResult {
  for (const path of paths) {
    const normalized = normalizePath(path)
    if (!normalized.startsWith(`/`)) {
      return {
        invariant: `I2: Canonical Path Form`,
        passed: false,
        message: `Normalized path "${normalized}" does not start with "/"`,
        details: { original: path, normalized },
      }
    }
    if (normalized !== `/` && normalized.endsWith(`/`)) {
      return {
        invariant: `I2: Canonical Path Form`,
        passed: false,
        message: `Normalized path "${normalized}" ends with "/" (not root)`,
        details: { original: path, normalized },
      }
    }
  }
  return { invariant: `I2: Canonical Path Form`, passed: true }
}

// I3: Filesystem Tree Consistency

export function checkTreeConsistency(
  snapshot: FilesystemSnapshot
): InvariantCheckResult {
  for (const [path] of snapshot.files) {
    if (path === `/`) continue
    const parent = dirname(path)
    if (!snapshot.directories.has(parent)) {
      return {
        invariant: `I3: Filesystem Tree Consistency`,
        passed: false,
        message: `File "${path}" has no parent directory "${parent}"`,
        details: { path, expectedParent: parent },
      }
    }
  }

  for (const path of snapshot.directories) {
    if (path === `/`) continue
    const parent = dirname(path)
    if (!snapshot.directories.has(parent)) {
      return {
        invariant: `I3: Filesystem Tree Consistency`,
        passed: false,
        message: `Directory "${path}" has no parent directory "${parent}"`,
        details: { path, expectedParent: parent },
      }
    }
  }

  return { invariant: `I3: Filesystem Tree Consistency`, passed: true }
}

// I4: Single Entity Per Path

export function checkSingleEntityPerPath(
  snapshot: FilesystemSnapshot
): InvariantCheckResult {
  for (const [path] of snapshot.files) {
    if (snapshot.directories.has(path)) {
      return {
        invariant: `I4: Single Entity Per Path`,
        passed: false,
        message: `Path "${path}" exists as both file and directory`,
        details: { path },
      }
    }
  }
  return { invariant: `I4: Single Entity Per Path`, passed: true }
}

// I5: Metadata-Content Consistency

export function checkMetadataContentConsistency(
  snapshot: FilesystemSnapshot
): InvariantCheckResult {
  for (const [path, file] of snapshot.files) {
    if (file.contentType === `text`) {
      const contentBytes = new TextEncoder().encode(file.content).length
      if (file.size !== contentBytes) {
        return {
          invariant: `I5: Metadata-Content Consistency`,
          passed: false,
          message: `File "${path}" size mismatch: metadata says ${file.size}, content is ${contentBytes} bytes`,
          details: { path, metadataSize: file.size, actualSize: contentBytes },
        }
      }
    }
  }
  return { invariant: `I5: Metadata-Content Consistency`, passed: true }
}

// I10: Modification Time Monotonicity (History-based)

export function checkModificationTimeMonotonicity(
  history: Array<HistoryEvent>
): InvariantCheckResult {
  const modTimes = new Map<string, number>()

  for (const event of history) {
    if (!event.success) continue

    if (event.step.op === `stat` && event.result) {
      const result = event.result as { modifiedAt?: string }
      if (result.modifiedAt) {
        const path = event.step.path
        const time = new Date(result.modifiedAt).getTime()
        const prevTime = modTimes.get(path)

        if (prevTime !== undefined && time < prevTime) {
          return {
            invariant: `I10: Modification Time Monotonicity`,
            passed: false,
            message: `File "${path}" modifiedAt went backwards`,
            details: { path, previousTime: prevTime, newTime: time },
          }
        }
        modTimes.set(path, time)
      }
    }
  }

  return { invariant: `I10: Modification Time Monotonicity`, passed: true }
}

// I11: Delete Completeness

export function checkDeleteCompleteness(
  history: Array<HistoryEvent>,
  finalSnapshot: FilesystemSnapshot
): InvariantCheckResult {
  const deletedPaths = new Set<string>()
  for (const event of history) {
    if (event.success && event.step.op === `deleteFile`) {
      deletedPaths.add(event.step.path)
    }
  }

  for (const path of deletedPaths) {
    if (finalSnapshot.files.has(path)) {
      return {
        invariant: `I11: Delete Completeness`,
        passed: false,
        message: `Deleted file "${path}" still exists in final snapshot`,
        details: { path },
      }
    }
  }

  return { invariant: `I11: Delete Completeness`, passed: true }
}

// Combined Invariant Check

export interface AllInvariantsResult {
  passed: boolean
  results: Array<InvariantCheckResult>
  failedInvariants: Array<string>
}

export function checkAllInvariants(
  snapshot: FilesystemSnapshot,
  history?: Array<HistoryEvent>
): AllInvariantsResult {
  const results: Array<InvariantCheckResult> = []

  results.push(checkTreeConsistency(snapshot))
  results.push(checkSingleEntityPerPath(snapshot))
  results.push(checkMetadataContentConsistency(snapshot))

  if (history) {
    results.push(checkModificationTimeMonotonicity(history))
    results.push(checkDeleteCompleteness(history, snapshot))
  }

  const failedInvariants = results
    .filter((r) => !r.passed)
    .map((r) => r.invariant)

  return {
    passed: failedInvariants.length === 0,
    results,
    failedInvariants,
  }
}

// Live Filesystem Check

export async function checkLiveFilesystem(
  fs: DurableFilesystem
): Promise<AllInvariantsResult> {
  const { takeSnapshot } = await import(`./dsl/scenario-builder`)
  const snapshot = await takeSnapshot(fs)
  return checkAllInvariants(snapshot)
}
