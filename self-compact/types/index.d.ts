export type Phase = 'idle' | 'notice' | 'warning' | 'forced'

export type Gauge = {
  tokens: number | null
  window: number
  soft: number
  warn: number
  forced: number
  phase: Phase
  isPending: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'self-compact': { gauge: Gauge | null; isOff: boolean }
  }
}
