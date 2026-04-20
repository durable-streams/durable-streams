#!/usr/bin/env node

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { execSync } from "node:child_process"

interface PublishedPackage {
  name: string
  version: string
}

interface PackageInfo {
  name: string
  pkgPath: string
  version: string
}

interface PRInfo {
  number: number
  packages: Array<PackageInfo>
}

interface IssueInfo {
  number: number
  prs: Set<number>
  packages: Array<PackageInfo>
}

function extractPRsFromChangelog(
  changelogPath: string,
  version: string
): Array<number> {
  try {
    const content = readFileSync(changelogPath, `utf-8`)
    const lines = content.split(`\n`)

    let inTargetVersion = false
    let foundVersion = false
    const prNumbers = new Set<number>()

    for (const line of lines) {
      if (line.startsWith(`## `)) {
        const versionMatch = line.match(/^## (\d+\.\d+\.\d+)/)
        if (versionMatch) {
          if (versionMatch[1] === version) {
            inTargetVersion = true
            foundVersion = true
          } else if (inTargetVersion) {
            break
          }
        }
      }

      if (inTargetVersion) {
        const prMatches = line.matchAll(
          /\[#(\d+)\]\(https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+\)/g
        )
        for (const match of prMatches) {
          prNumbers.add(parseInt(match[1], 10))
        }
      }
    }

    if (!foundVersion) {
      console.warn(
        `Warning: Could not find version ${version} in ${changelogPath}`
      )
    }

    return Array.from(prNumbers)
  } catch (error) {
    console.error(`Error reading changelog at ${changelogPath}:`, error)
    return []
  }
}

function groupPRsByNumber(
  publishedPackages: Array<PublishedPackage>
): Map<number, PRInfo> {
  const prMap = new Map<number, PRInfo>()

  for (const pkg of publishedPackages) {
    const pkgPath = `packages/${pkg.name.replace(`@durable-streams/`, ``)}`
    const changelogPath = resolve(process.cwd(), pkgPath, `CHANGELOG.md`)
    const prNumbers = extractPRsFromChangelog(changelogPath, pkg.version)

    for (const prNumber of prNumbers) {
      if (!prMap.has(prNumber)) {
        prMap.set(prNumber, { number: prNumber, packages: [] })
      }
      prMap.get(prNumber)!.packages.push({
        name: pkg.name,
        pkgPath,
        version: pkg.version,
      })
    }
  }

  return prMap
}

function hasExistingComment(number: number, repository: string): boolean {
  try {
    const result = execSync(
      `gh api repos/${repository}/issues/${number}/comments --jq '[.[] | select(.body | contains("has been released!"))] | length'`,
      { encoding: `utf-8`, stdio: [`pipe`, `pipe`, `pipe`] }
    )
    return parseInt(result.trim(), 10) > 0
  } catch (error) {
    console.error(
      `Error checking existing comments for #${number}: ${error instanceof Error ? error.message : error}`
    )
    return false
  }
}

function findLinkedIssues(prNumber: number, repository: string): Array<number> {
  const [owner, repo] = repository.split(`/`)
  const query = `
    query($owner: String!, $repo: String!, $pr: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $pr) {
          closingIssuesReferences(first: 10) {
            nodes {
              number
            }
          }
        }
      }
    }
  `

  try {
    const result = execSync(
      `gh api graphql -f query='${query}' -F owner='${owner}' -F repo='${repo}' -F pr=${prNumber} --jq '.data.repository.pullRequest.closingIssuesReferences.nodes[].number'`,
      { encoding: `utf-8`, stdio: [`pipe`, `pipe`, `pipe`] }
    )

    const issueNumbers = result
      .trim()
      .split(`\n`)
      .filter((line) => line)
      .map((line) => parseInt(line, 10))

    if (issueNumbers.length > 0) {
      console.log(
        `  PR #${prNumber} links to issues: ${issueNumbers.join(`, `)}`
      )
    }

    return issueNumbers
  } catch (error) {
    console.error(
      `Failed to fetch linked issues for PR #${prNumber}: ${error instanceof Error ? error.message : error}`
    )
    return []
  }
}

function formatPackageList(
  packages: Array<PackageInfo>,
  repository: string
): string {
  return packages
    .map((pkg) => {
      const anchor = pkg.version.replace(/\./g, ``)
      const changelogUrl = `https://github.com/${repository}/blob/main/${pkg.pkgPath}/CHANGELOG.md#${anchor}`
      return `- [${pkg.name}@${pkg.version}](${changelogUrl})`
    })
    .join(`\n`)
}

function commentOnPR(pr: PRInfo, repository: string): void {
  const { number, packages } = pr

  if (hasExistingComment(number, repository)) {
    console.log(`↷ Already commented on PR #${number}, skipping`)
    return
  }

  const packageList = formatPackageList(packages, repository)
  const comment = `🎉 This PR has been released!\n\n${packageList}\n\nThank you for your contribution!`

  try {
    execSync(`gh pr comment ${number} --body-file -`, {
      input: comment,
      stdio: [`pipe`, `inherit`, `inherit`],
    })
    console.log(`✓ Commented on PR #${number}`)
  } catch (error) {
    console.error(`✗ Failed to comment on PR #${number}:`, error)
  }
}

function commentOnIssue(issue: IssueInfo, repository: string): void {
  const { number, prs, packages } = issue

  if (hasExistingComment(number, repository)) {
    console.log(`↷ Already commented on issue #${number}, skipping`)
    return
  }

  const prLinks = Array.from(prs)
    .map((pr) => `#${pr}`)
    .join(`, `)
  const prWord = prs.size === 1 ? `PR` : `PRs`
  const verb = prs.size === 1 ? `has` : `have`
  const packageList = formatPackageList(packages, repository)
  const comment = `🎉 The ${prWord} fixing this issue (${prLinks}) ${verb} been released!\n\n${packageList}\n\nThank you for reporting!`

  try {
    execSync(`gh issue comment ${number} --body-file -`, {
      input: comment,
      stdio: [`pipe`, `inherit`, `inherit`],
    })
    console.log(`✓ Commented on issue #${number}`)
  } catch (error) {
    console.error(`✗ Failed to comment on issue #${number}:`, error)
  }
}

function main(): void {
  const publishedPackagesJson = process.env.PUBLISHED_PACKAGES
  const repository = process.env.REPOSITORY

  if (!publishedPackagesJson) {
    console.log(`No packages were published. Skipping PR comments.`)
    return
  }

  if (!repository) {
    console.log(`Repository is missing. Skipping PR comments.`)
    return
  }

  let publishedPackages: Array<PublishedPackage>
  try {
    publishedPackages = JSON.parse(publishedPackagesJson)
  } catch (error) {
    console.error(`Failed to parse PUBLISHED_PACKAGES:`, error)
    process.exit(1)
  }

  if (publishedPackages.length === 0) {
    console.log(`No packages were published. Skipping PR comments.`)
    return
  }

  console.log(`Processing ${publishedPackages.length} published package(s)...`)

  const prMap = groupPRsByNumber(publishedPackages)

  if (prMap.size === 0) {
    console.log(`No PRs found in CHANGELOGs. Nothing to comment on.`)
    return
  }

  console.log(`Found ${prMap.size} PR(s) to comment on...`)

  const issueMap = new Map<number, IssueInfo>()

  for (const pr of prMap.values()) {
    commentOnPR(pr, repository)

    const linkedIssues = findLinkedIssues(pr.number, repository)
    for (const issueNumber of linkedIssues) {
      if (!issueMap.has(issueNumber)) {
        issueMap.set(issueNumber, {
          number: issueNumber,
          prs: new Set(),
          packages: [],
        })
      }
      const issueInfo = issueMap.get(issueNumber)!
      issueInfo.prs.add(pr.number)

      for (const pkg of pr.packages) {
        const isDuplicate = issueInfo.packages.some(
          (p) => p.name === pkg.name && p.version === pkg.version
        )
        if (!isDuplicate) {
          issueInfo.packages.push(pkg)
        }
      }
    }
  }

  if (issueMap.size > 0) {
    console.log(`\nFound ${issueMap.size} linked issue(s) to comment on...`)

    for (const issue of issueMap.values()) {
      commentOnIssue(issue, repository)
    }
  }

  console.log(`\n✓ Done!`)
}

try {
  main()
} catch (error) {
  console.error(`Fatal error:`, error)
  process.exit(1)
}
