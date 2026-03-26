/**
 * Git operations for session fork/clone.
 */

import { execSync } from "node:child_process"
import * as fs from "node:fs"

interface ExecResult {
  stdout: string
  success: boolean
}

function git(command: string, cwd?: string): ExecResult {
  try {
    const stdout = execSync(`git ${command}`, {
      cwd,
      encoding: `utf-8`,
      stdio: [`pipe`, `pipe`, `pipe`],
    }).trim()
    return { stdout, success: true }
  } catch (err: unknown) {
    const error = err as { stdout?: string; stderr?: string }
    return { stdout: error.stdout?.trim() ?? ``, success: false }
  }
}

function gitOrThrow(command: string, cwd?: string): string {
  const result = git(command, cwd)
  if (!result.success) {
    throw new Error(`git ${command} failed`)
  }
  return result.stdout
}

/**
 * Check if the given directory is inside a git repository.
 */
export function isGitRepo(cwd: string): boolean {
  return git(`rev-parse --is-inside-work-tree`, cwd).success
}

/**
 * Get the current branch name.
 */
export function getCurrentBranch(cwd: string): string {
  return gitOrThrow(`rev-parse --abbrev-ref HEAD`, cwd)
}

/**
 * Get the remote URL for a given remote name.
 */
export function getRemoteUrl(cwd: string, remote = `origin`): string {
  return gitOrThrow(`remote get-url ${remote}`, cwd)
}

/**
 * Check if there are any local changes (staged, unstaged, or untracked).
 */
export function hasLocalChanges(cwd: string): boolean {
  const status = gitOrThrow(`status --porcelain`, cwd)
  return status.length > 0
}

/**
 * Export the current working state to a git branch and push it.
 * Uses git plumbing (temporary index + write-tree + commit-tree) so the
 * working directory, real index, and current branch are completely untouched.
 */
export function exportBranch(
  cwd: string,
  branchName: string,
  remote = `origin`
): void {
  const tmpIndex = `/tmp/ds-cc-export-index-${Date.now()}`
  const env = { GIT_INDEX_FILE: tmpIndex }

  try {
    // Stage the entire working directory into a temporary index
    execSync(`git add -A`, {
      cwd,
      env: { ...process.env, ...env },
      stdio: [`pipe`, `pipe`, `pipe`],
    })

    // Write the temporary index as a tree object
    const tree = execSync(`git write-tree`, {
      cwd,
      env: { ...process.env, ...env },
      encoding: `utf-8`,
      stdio: [`pipe`, `pipe`, `pipe`],
    }).trim()

    // Create a commit with that tree, parented on HEAD
    const head = gitOrThrow(`rev-parse HEAD`, cwd)
    const commit = execSync(
      `git commit-tree ${tree} -p ${head} -m "CC session fork: ${branchName}"`,
      { cwd, encoding: `utf-8`, stdio: [`pipe`, `pipe`, `pipe`] }
    ).trim()

    // Create a branch pointing to that commit
    gitOrThrow(`branch ${branchName} ${commit}`, cwd)

    // Push to remote
    gitOrThrow(`push ${remote} ${branchName}`, cwd)
  } finally {
    // Clean up temporary index file
    try {
      fs.unlinkSync(tmpIndex)
    } catch {
      // ignore
    }
  }
}

/**
 * Import a branch by fetching it and creating a worktree with a new branch.
 * Returns the absolute path to the worktree.
 */
export function importBranch(
  cwd: string,
  remoteBranch: string,
  newBranchName: string,
  worktreePath: string,
  remote = `origin`
): void {
  // Fetch the remote branch
  gitOrThrow(`fetch ${remote} ${remoteBranch}`, cwd)

  // Create worktree on a new branch forked from the fetched branch
  gitOrThrow(
    `worktree add ${worktreePath} -b ${newBranchName} ${remote}/${remoteBranch}`,
    cwd
  )
}
