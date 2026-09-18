#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const skillsDir = join(__dirname, `..`, `skills`)

interface SkillMetadata {
  name: string
  description: string
}

function parseSkillFrontmatter(content: string): SkillMetadata | null {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/)
  if (!frontmatterMatch?.[1]) return null

  const frontmatter = frontmatterMatch[1]
  const nameMatch = frontmatter.match(/^name:\s*(.+)$/m)
  const descMatch = frontmatter.match(/^description:\s*(.+)$/m)

  if (!nameMatch?.[1]) return null

  return {
    name: nameMatch[1].trim(),
    description: descMatch?.[1]?.trim() ?? ``,
  }
}

function getSkills(): Map<string, { path: string; metadata: SkillMetadata }> {
  const skills = new Map<string, { path: string; metadata: SkillMetadata }>()

  if (!existsSync(skillsDir)) {
    return skills
  }

  const entries = readdirSync(skillsDir, { withFileTypes: true })

  for (const entry of entries) {
    if (!entry.isDirectory()) continue

    const skillPath = join(skillsDir, entry.name, `SKILL.md`)
    if (!existsSync(skillPath)) continue

    const content = readFileSync(skillPath, `utf-8`)
    const metadata = parseSkillFrontmatter(content)

    if (metadata) {
      skills.set(metadata.name, { path: skillPath, metadata })
    }
  }

  return skills
}

function listSkills(): void {
  const skills = getSkills()

  if (skills.size === 0) {
    console.log(`No skills found.`)
    return
  }

  console.log(`Durable Streams Playbook\n`)
  console.log(`Available skills:\n`)

  for (const [name, { metadata }] of skills) {
    console.log(`  ${name}`)
    if (metadata.description) {
      console.log(`    ${metadata.description}\n`)
    }
  }

  console.log(
    `\nUse 'durable-streams-playbook show <skill>' to view a skill's content.`
  )
  console.log(`\nTip: Search skills by keyword with grep:`)
  console.log(
    `  grep -r "keyword" node_modules/@durable-streams/playbook/skills/`
  )
}

function showSkill(skillName: string): void {
  const skills = getSkills()
  const skill = skills.get(skillName)

  if (!skill) {
    console.error(`Skill not found: ${skillName}`)
    console.error(`\nAvailable skills:`)
    for (const name of skills.keys()) {
      console.error(`  - ${name}`)
    }
    process.exit(1)
  }

  const content = readFileSync(skill.path, `utf-8`)
  console.log(content)
}

function main(): void {
  const args = process.argv.slice(2)
  const command = args[0]

  switch (command) {
    case `list`:
      listSkills()
      break
    case `show`:
      if (!args[1]) {
        console.error(`Usage: durable-streams-playbook show <skill-name>`)
        process.exit(1)
      }
      showSkill(args[1])
      break
    case `--help`:
    case `-h`:
    case undefined:
      console.log(`Durable Streams Playbook CLI

Usage:
  durable-streams-playbook list           List all available skills
  durable-streams-playbook show <skill>   Show the full content of a skill
  durable-streams-playbook --help         Show this help message

Examples:
  durable-streams-playbook list
  durable-streams-playbook show durable-streams
  durable-streams-playbook show durable-state
`)
      break
    default:
      console.error(`Unknown command: ${command}`)
      console.error(`Run 'durable-streams-playbook --help' for usage.`)
      process.exit(1)
  }
}

main()
