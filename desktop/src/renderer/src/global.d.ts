import type { AnyBuffApi } from '../../preload'

declare global {
  interface Window {
    AnyBuff: AnyBuffApi
  }
}

export {}
