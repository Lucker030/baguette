import type { Provider } from '@shared/types'

export const PROVIDER_UI: Record<Provider, { label: string; color: string }> = {
  claude: { label: 'Claude', color: '#d97757' },
  codex: { label: 'ChatGPT', color: '#10a37f' },
  copilot: { label: 'Copilot', color: '#2f81f7' },
  shell: { label: 'Shell', color: '#7d8590' }
}
