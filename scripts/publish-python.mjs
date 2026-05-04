/**
 * Build and publish Python packages to PyPI.
 * This script is called by Changesets during the publish command.
 */

import { execFileSync } from "node:child_process"
import { rmSync } from "node:fs"

const PY_PKGS = [
  {
    dir: `packages/client-py`,
  },
]

for (const pkg of PY_PKGS) {
  console.log(`\nBuilding ${pkg.dir}...`)

  // Clean any existing dist directory
  try {
    rmSync(`${pkg.dir}/dist`, { recursive: true, force: true })
  } catch {
    // Ignore if doesn't exist
  }

  // Build the package
  // --no-sources ensures the build works without any local source overrides
  execFileSync(`uv`, [`build`, `--directory`, pkg.dir, `--no-sources`], {
    stdio: `inherit`,
  })

  console.log(`Publishing ${pkg.dir}...`)

  // Publish to PyPI.
  // Uses UV_PUBLISH_TOKEN env var for authentication.
  // --check-url makes this idempotent: uv skips files already on the index,
  // so the script is safe to run on every release (e.g. TS-only changesets
  // where pyproject.toml's version was not bumped).
  execFileSync(
    `uv`,
    [
      `publish`,
      `--directory`,
      pkg.dir,
      `--check-url`,
      `https://pypi.org/simple/`,
    ],
    { stdio: `inherit` }
  )

  console.log(`Successfully published ${pkg.dir}`)
}

console.log(`\nAll Python packages published successfully`)
