import type { LocalPlatformApi } from './index'

declare global {
  interface Window {
    api: LocalPlatformApi
  }
}

export {}
