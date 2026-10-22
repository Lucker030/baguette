import { renameSync, unlinkSync, writeFileSync } from 'node:fs'

/**
 * Write a file by writing a sibling temp file and renaming it into place.
 *
 * `writeFileSync` truncates the target before it writes, so a crash, a power
 * loss, or a full disk mid-write leaves a zero-byte or half-written file. That
 * matters most for the files this app does not own — above all
 * `~/.claude/settings.json`, where a truncated file is then unparseable on the
 * next run. A rename is atomic on both NTFS and POSIX, so a reader either sees
 * the whole old file or the whole new one.
 */
export function writeFileAtomic(path: string, contents: string): void {
  const tmp = `${path}.tmp-${process.pid}`
  try {
    writeFileSync(tmp, contents, 'utf8')
    renameSync(tmp, path)
  } catch (err) {
    try {
      unlinkSync(tmp)
    } catch {
      /* temp file never got created, or is already gone */
    }
    throw err
  }
}
