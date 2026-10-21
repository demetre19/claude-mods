export type CalmNotes = string[]

declare module 'claude-code' {
  interface PluginState {
    calm: { isOff: boolean; frame: number; notes: CalmNotes }
  }
}
