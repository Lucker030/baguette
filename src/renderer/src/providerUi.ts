import type { Provider } from '@shared/types'

export const PROVIDER_UI: Record<Provider, { label: string; color: string }> = {
  claude: { label: 'Claude', color: '#d97757' },
  codex: { label: 'Codex', color: '#10a37f' },
  copilot: { label: 'Copilot', color: '#2f81f7' },
  antigravity: { label: 'Antigravity', color: '#a142f4' },
  shell: { label: 'Shell', color: '#7d8590' }
}
