import type { CreateSessionOptions } from '../shared/types'

// The permission flags a tab's CLI starts with. Kept apart from pty-manager.ts
// (which pulls in electron and node-pty) so the rules can be tested directly.

/**
 * Flags that start a CLI without the ability to change anything: Claude Code's
 * plan mode, Codex's read-only sandbox, agy's plan mode. Used for tabs another
 * agent opens through the agent bridge (agent-bridge.ts), so a conversation
 * the user is only watching can't edit files or run commands behind their back.
 * They go BEFORE the launch args: `codex resume <id>` is a subcommand, and its
 * global flags have to precede it.
 *
 * Read-only alone is not enough: each CLI can ASK to step outside it (Codex:
 * "run this outside the sandbox?", Claude: leave plan mode), and the default
 * answer is yes — so the bridge's own Enter, sent with every message, would
 * approve it (verified with Codex). So the escape hatches are shut too: Codex
 * never asks, Claude doesn't get the tools that write or leave plan mode. agy
 * has no "never ask" switch; its terminal sandbox is the most it offers.
 * `--disallowedTools=` keeps Claude's variadic flag from eating what follows.
 */
export function readOnlyArgs(provider: CreateSessionOptions['provider']): string[] {
  switch (provider) {
    case 'claude':
      return ['--permission-mode', 'plan', '--disallowedTools=Bash,Edit,Write,NotebookEdit,ExitPlanMode']
    case 'codex':
      return ['--sandbox', 'read-only', '--ask-for-approval', 'never']
    case 'antigravity':
      return ['--mode', 'plan', '--sandbox']
    default:
      return []
  }
}

/**
 * The CLI's own "approve every permission request" switch, for providers the
 * user turned on in settings.autoApprove. agy otherwise stops before every
 * shell command (even `Test-Path`), which makes a tab driven through the agent
 * bridge unusable.
 */
export function autoApproveArgs(provider: CreateSessionOptions['provider']): string[] {
  switch (provider) {
    case 'antigravity':
      return ['--dangerously-skip-permissions']
    default:
      return []
  }
}

/**
 * The permission flags for a tab. readOnly wins: a read-only tab stays
 * read-only whatever autoApprove says.
 */
export function modeArgs(opts: Pick<CreateSessionOptions, 'provider' | 'readOnly' | 'autoApprove'>): string[] {
  if (opts.readOnly) return readOnlyArgs(opts.provider)
  if (opts.autoApprove) return autoApproveArgs(opts.provider)
  return []
}
