export type PublishedSuggestion = { label: string; prompt: string }

declare module 'claude-code' {
  interface PluginState {
    'next-steps-desktop': {
      suggestions: PublishedSuggestion[]
    }
  }
}
