export type Deploy = {
  sha: string
  at: string
  workflow: string
  event: string
  branch: string
  url: string
}

export type Running = { workflow: string; status: string; sha: string; at: string; url: string }

export type MyCommit = {
  sha: string
  at: string
  title: string
  onProd: boolean | null
  onInteg: boolean | null
}

export type Snapshot =
  | { kind: 'loading' }
  | { kind: 'error'; message: string; at: string }
  | {
      kind: 'ready'
      at: string
      repo: string
      login: string
      prod: Deploy | null
      integ: Deploy | null
      running: Running[]
      commits: MyCommit[]
    }

declare module 'claude-code' {
  interface PluginState {
    'deploy-status': { snapshot: Snapshot | null }
  }
}
