import { existsSync, readFileSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const skillsDir = join(__dirname, `..`, `skills`)

export interface SkillMetadata {
  name: string
  description: string
}

export interface Skill {
  name: string
  description: string
  content: string
}

function parseSkillFrontmatter(content: string): SkillMetadata | null {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/)
  if (!frontmatterMatch) return null

  const frontmatter = frontmatterMatch[1]
  const nameMatch = frontmatter.match(/^name:\s*(.+)$/m)
  const descMatch = frontmatter.match(/^description:\s*(.+)$/m)

  if (!nameMatch) return null

  return {
    name: nameMatch[1].trim(),
    description: descMatch ? descMatch[1].trim() : ``,
  }
}

/**
 * List all available skills with their metadata
 */
export function listSkills(): Array<SkillMetadata> {
  const skills: Array<SkillMetadata> = []

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
      skills.push(metadata)
    }
  }

  return skills
}

/**
 * Get the full content of a skill by name
 */
export function getSkill(name: string): Skill | null {
  if (!existsSync(skillsDir)) {
    return null
  }

  const entries = readdirSync(skillsDir, { withFileTypes: true })

  for (const entry of entries) {
    if (!entry.isDirectory()) continue

    const skillPath = join(skillsDir, entry.name, `SKILL.md`)
    if (!existsSync(skillPath)) continue

    const content = readFileSync(skillPath, `utf-8`)
    const metadata = parseSkillFrontmatter(content)

    if (metadata && metadata.name === name) {
      return {
        name: metadata.name,
        description: metadata.description,
        content,
      }
    }
  }

  return null
}
