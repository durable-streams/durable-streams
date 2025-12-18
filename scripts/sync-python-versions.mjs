/**
 * Sync Python package versions from bridge package.json files to pyproject.toml
 * This script is called by Changesets during the version command.
 */

import { readFile } from "node:fs/promises"
import { execFileSync } from "node:child_process"

const PY_PKGS = [
  {
    dir: `packages/client-py`,
    bridge: `packages/client-py/package.json`,
  },
]

/**
 * Convert semver prereleases to PEP 440 format
 * e.g., 1.2.3-alpha.1 -> 1.2.3a1
 */
function toPep440(version) {
  return version
    .replace(/-alpha\.(\d+)$/, `a$1`)
    .replace(/-beta\.(\d+)$/, `b$1`)
    .replace(/-rc\.(\d+)$/, `rc$1`)
    .replace(/-dev\.(\d+)$/, `.dev$1`)
}

for (const pkg of PY_PKGS) {
  const { version } = JSON.parse(await readFile(pkg.bridge, `utf8`))
  const pep440Version = toPep440(version)

  console.log(`Syncing ${pkg.dir} to version ${pep440Version}`)

  execFileSync(
    `uv`,
    [`--directory`, pkg.dir, `version`, pep440Version, `--frozen`],
    { stdio: `inherit` }
  )
}

console.log(`Python versions synced successfully`)
