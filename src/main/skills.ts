import { readdirSync, readFileSync, existsSync, statSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'
import type { SkillInfo } from '../shared/types'

interface Root {
  root: string
  source: string
}

/**
 * Directories that may contain Claude skills, each a folder with a SKILL.md.
 *
 * The project root is the user's default working directory, not
 * `process.cwd()`: for the installed app cwd is wherever the shortcut launched
 * it from (typically the install dir), so a project-scoped `.claude/skills`
 * could never have been found there.
 */
function skillRoots(projectRoot?: string): Root[] {
  const home = os.homedir()
  const roots: Root[] = [{ root: join(home, '.claude', 'skills'), source: 'user (~/.claude)' }]
  if (projectRoot) {
    const projectSkills = join(projectRoot, '.claude', 'skills')
    if (projectSkills !== roots[0].root) roots.push({ root: projectSkills, source: 'project (預設工作目錄)' })
  }
  return roots
}

/** Extract `name` and `description` from a SKILL.md YAML frontmatter block. */
function parseFrontmatter(md: string): { name?: string; description?: string } {
  if (!md.startsWith('---')) return {}
  const end = md.indexOf('\n---', 3)
  if (end === -1) return {}
  const block = md.slice(3, end)
  const lines = block.split(/\r?\n/)
  const out: { name?: string; description?: string } = {}
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const m = /^(name|description):\s*(.*)$/.exec(line)
    if (!m) continue
    const key = m[1] as 'name' | 'description'
    let value = m[2].trim()
    // Handle folded/literal block scalars (`>` or `|`): gather indented lines.
    if (value === '>' || value === '|' || value === '') {
      const gathered: string[] = value && value !== '>' && value !== '|' ? [value] : []
      for (let j = i + 1; j < lines.length; j++) {
        if (/^\s+\S/.test(lines[j])) gathered.push(lines[j].trim())
        else break
      }
      value = gathered.join(' ').trim()
    }
    value = value.replace(/^["']|["']$/g, '')
    out[key] = value
  }
  return out
}

/** Scan all known roots and return the discovered skills. */
export function listSkills(projectRoot?: string): SkillInfo[] {
  const results: SkillInfo[] = []
  const seen = new Set<string>()

  for (const { root, source } of skillRoots(projectRoot)) {
    if (!existsSync(root)) continue
    let entries: string[]
    try {
      entries = readdirSync(root)
    } catch {
      continue
    }
    for (const entry of entries) {
      const dir = join(root, entry)
      let isDir: boolean
      try {
        isDir = statSync(dir).isDirectory()
      } catch {
        continue
      }
      if (!isDir) continue

      const skillMd = join(dir, 'SKILL.md')
      const hasSkillMd = existsSync(skillMd)
      let meta: { name?: string; description?: string } = {}
      if (hasSkillMd) {
        try {
          meta = parseFrontmatter(readFileSync(skillMd, 'utf8'))
        } catch {
          /* unreadable — fall back to folder name */
        }
      }

      const id = `${source}:${entry}`
      if (seen.has(id)) continue
      seen.add(id)

      results.push({
        id,
        name: meta.name || entry,
        description: meta.description || (hasSkillMd ? '' : '（此資料夾沒有 SKILL.md）'),
        path: dir,
        source,
        hasSkillMd
      })
    }
  }

  results.sort((a, b) => a.name.localeCompare(b.name))
  return results
}

/** Turn a display name into a safe skill folder name. */
function skillSlug(name: string): string {
  const base = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return base || 'skill'
}

/**
 * Create a new skill under ~/.claude/skills/<slug>/SKILL.md with YAML
 * frontmatter. Returns the created SkillInfo. Throws if the folder exists.
 */
export function createSkill(name: string, description: string): SkillInfo {
  const home = os.homedir()
  const root = join(home, '.claude', 'skills')
  const slug = skillSlug(name)
  let dir = join(root, slug)
  // Avoid clobbering an existing skill folder.
  let suffix = 2
  while (existsSync(dir)) {
    dir = join(root, `${slug}-${suffix++}`)
  }
  mkdirSync(dir, { recursive: true })

  const cleanName = name.trim() || slug
  const cleanDesc = description.trim()
  const md = `---\nname: ${cleanName}\ndescription: ${cleanDesc}\n---\n\n# ${cleanName}\n\n${cleanDesc}\n`
  writeFileSync(join(dir, 'SKILL.md'), md, 'utf8')

  return {
    id: `user (~/.claude):${dir.split(/[\\/]/).pop()}`,
    name: cleanName,
    description: cleanDesc,
    path: dir,
    source: 'user (~/.claude)',
    hasSkillMd: true
  }
}
