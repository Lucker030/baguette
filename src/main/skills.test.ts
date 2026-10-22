import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// skills.ts hand-rolls a small YAML frontmatter parser instead of taking a
// dependency. These tests pin the shapes it actually has to survive in real
// SKILL.md files — notably block scalars, which several bundled skills use.

let home: string
let roots: string[] = []

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  const homedir = (): string => home
  return { ...actual, homedir, default: { ...actual, homedir } }
})

const skillsRoot = (): string => join(home, '.claude', 'skills')

function writeSkill(name: string, skillMd: string | null): void {
  const dir = join(skillsRoot(), name)
  mkdirSync(dir, { recursive: true })
  if (skillMd !== null) writeFileSync(join(dir, 'SKILL.md'), skillMd, 'utf8')
}

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'lp-skills-'))
  roots.push(root)
  home = join(root, 'home')
  mkdirSync(skillsRoot(), { recursive: true })
  vi.resetModules()
})

afterEach(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
  roots = []
})

describe('listSkills', () => {
  it('reads name and description out of plain frontmatter', async () => {
    writeSkill('my-helper', '---\nname: My Helper\ndescription: Does a thing\n---\n\n# body\n')

    const { listSkills } = await import('./skills')
    const [skill] = listSkills()

    expect(skill.name).toBe('My Helper')
    expect(skill.description).toBe('Does a thing')
    expect(skill.hasSkillMd).toBe(true)
  })

  it('joins a folded block-scalar description into one line', async () => {
    writeSkill(
      'blocky',
      ['---', 'name: Blocky', 'description: >', '  first line', '  second line', '---', ''].join('\n')
    )

    const { listSkills } = await import('./skills')
    expect(listSkills()[0].description).toBe('first line second line')
  })

  it('strips surrounding quotes from a quoted value', async () => {
    writeSkill('quoted', '---\nname: "Quoted Name"\ndescription: \'q desc\'\n---\n')

    const { listSkills } = await import('./skills')
    const [skill] = listSkills()
    expect(skill.name).toBe('Quoted Name')
    expect(skill.description).toBe('q desc')
  })

  it('falls back to the folder name and flags a skill with no SKILL.md', async () => {
    writeSkill('orphan', null)

    const { listSkills } = await import('./skills')
    const [skill] = listSkills()

    expect(skill.name).toBe('orphan')
    expect(skill.hasSkillMd).toBe(false)
    expect(skill.description).toContain('沒有 SKILL.md')
  })

  it('falls back to the folder name when frontmatter is absent or unterminated', async () => {
    writeSkill('no-frontmatter', '# just a heading\n')
    writeSkill('unterminated', '---\nname: Never Closed\n')

    const { listSkills } = await import('./skills')
    const names = listSkills().map((s) => s.name).sort()
    expect(names).toEqual(['no-frontmatter', 'unterminated'])
  })

  it('sorts by display name and ignores loose files in the skills root', async () => {
    writeSkill('b-skill', '---\nname: Zebra\ndescription: z\n---\n')
    writeSkill('a-skill', '---\nname: Alpha\ndescription: a\n---\n')
    writeFileSync(join(skillsRoot(), 'stray.md'), 'not a skill')

    const { listSkills } = await import('./skills')
    expect(listSkills().map((s) => s.name)).toEqual(['Alpha', 'Zebra'])
  })

  it('returns nothing when the skills root does not exist', async () => {
    rmSync(skillsRoot(), { recursive: true, force: true })

    const { listSkills } = await import('./skills')
    expect(listSkills()).toEqual([])
  })
})

describe('createSkill', () => {
  it('writes a SKILL.md with frontmatter under a slugified folder', async () => {
    const { createSkill, listSkills } = await import('./skills')
    const created = createSkill('My New Skill', 'when to use it')

    expect(created.path).toBe(join(skillsRoot(), 'my-new-skill'))
    expect(created.name).toBe('My New Skill')

    // Round-trips: what we wrote is what the scanner reads back.
    const [found] = listSkills()
    expect(found.name).toBe('My New Skill')
    expect(found.description).toBe('when to use it')
  })

  it('never clobbers an existing skill folder', async () => {
    writeSkill('taken', '---\nname: Original\ndescription: keep me\n---\n')

    const { createSkill, listSkills } = await import('./skills')
    createSkill('taken', 'the new one')

    const descriptions = listSkills().map((s) => s.description).sort()
    expect(descriptions).toEqual(['keep me', 'the new one'])
  })
})
