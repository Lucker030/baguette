import type { BaguetteApi } from './index'

declare global {
  interface Window {
    api: BaguetteApi
  }
}

export {}
