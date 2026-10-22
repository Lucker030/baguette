/**
 * Wrap a path in double quotes when it contains whitespace, matching what
 * native terminals type on drag-and-drop.
 *
 * Unquoted, a shell reads `C:\My Projects\x` as two arguments — and this app's
 * own install path (`…\Local Platform\…`) contains a space, so the spaced case
 * is the normal one here, not an edge case. Paths that already carry a quote
 * are left alone rather than double-quoted into something worse.
 */
export function quoteForShell(path: string): string {
  if (!/\s/.test(path)) return path
  if (path.startsWith('"') && path.endsWith('"')) return path
  return `"${path}"`
}
