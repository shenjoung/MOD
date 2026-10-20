export type TaskForm = { person: string; issue: string; isNewPerson: boolean }
export type Mode = 'date' | 'person' | 'both' | 'off'

export type ExplainView =
  | { kind: 'idle' }
  | { kind: 'empty' }
  | { kind: 'loading'; target: string }
  | { kind: 'done'; target: string; text: string }
  | { kind: 'error'; message: string }

declare module 'claude-code' {
  interface PluginState {
    'task-sort': {
      pending: boolean
      form: TaskForm
      mode: Mode
      explain: ExplainView
      forkArmed: string | null
    }
  }
}
