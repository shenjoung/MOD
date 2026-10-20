import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const PROD_SHA = 'p'.repeat(40)
const INTEG_SHA = 'i'.repeat(40)
const MINE_OLD = 'a'.repeat(40) // on both
const MINE_NEW = 'b'.repeat(40) // on integ only

const RUNS: Record<string, unknown[]> = {
  'deploy.yml': [
    { status: 'in_progress', conclusion: '', headSha: 'n'.repeat(40), headBranch: 'main', createdAt: '2026-10-08T02:00:00Z', event: 'workflow_dispatch', url: 'u' },
    { status: 'completed', conclusion: 'success', headSha: PROD_SHA, headBranch: 'main', createdAt: '2026-10-07T10:36:12Z', event: 'workflow_dispatch', url: 'u' },
  ],
  'integ-sync.yml': [
    { status: 'completed', conclusion: 'success', headSha: INTEG_SHA, headBranch: 'main', createdAt: '2026-10-07T16:37:06Z', event: 'push', url: 'u' },
  ],
  'integ-deploy.yml': [
    { status: 'completed', conclusion: 'failure', headSha: 'f'.repeat(40), headBranch: 'main', createdAt: '2026-10-07T18:00:00Z', event: 'workflow_dispatch', url: 'u' },
  ],
}

// Beneath the plugin: a fake `gh` answering the read-only calls the pane makes,
// recording every argv so the test can check nothing but reads was run.
function engine(on: On) {
  const argvs: string[][] = []
  on('process.run', async (_$, e) => {
    argvs.push([...e.argv])
    const a = e.argv
    let out: unknown = null
    if (a[1] === 'run' && a[2] === 'list') out = RUNS[a[a.indexOf('--workflow') + 1] ?? ''] ?? []
    else if (a[2] === 'user') out = { login: 'hourloop-jonesfang' }
    else if (String(a[2]).includes('/commits?')) {
      out = [
        { sha: MINE_NEW, at: '2026-10-07T12:00:00Z', title: 'newer change' },
        { sha: MINE_OLD, at: '2026-10-06T12:00:00Z', title: 'older change' },
      ]
    } else if (String(a[2]).includes('/compare/')) {
      const [mine, deployed] = String(a[2]).split('/compare/')[1]!.split('...')
      out = { status: mine === MINE_NEW && deployed === PROD_SHA ? 'behind' : 'ahead' }
    }
    return { value: { exitCode: 0, stdout: JSON.stringify(out), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  return { argvs }
}

const PANE = {
  component: 'Pane',
  requestId: 'deploy-status',
  props: { title: 'Deploys', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

async function settle(): Promise<void> {
  for (let i = 0; i < 300; i++) await Promise.resolve()
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`/deploys shows prod, integ, running deploys and my commits on ${surface}`, async ($, on) => {
    const { argvs } = engine(on)
    await $.command.run({ command: 'deploys', args: '', origin: { kind: 'sdk' }, presentation: { isFullscreen: false, columns: 100 } })
    await settle()
    const ui = await $.ui.mount({ plugin: 'deploy-status', surface, ...PANE })

    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text).join('\n')
    expect(texts).toContain(`prod  ${PROD_SHA.slice(0, 9)}  10/07 18:36  deploy.yml`)
    expect(texts).toContain(`integ ${INTEG_SHA.slice(0, 9)}  10/08 00:37  integ-sync.yml`)
    expect(texts).toContain('deploy.yml  in_progress')
    expect(texts).toContain(`${MINE_NEW.slice(0, 9)}  integ live  prod not live`)
    expect(texts).toContain(`${MINE_OLD.slice(0, 9)}  integ live  prod live`)

    // Read-only: list runs and GET the API, nothing else.
    for (const a of argvs) {
      const ok = (a[1] === 'run' && a[2] === 'list') || (a[1] === 'api' && !a.includes('-X') && !a.includes('--method'))
      expect(ok).toBe(true)
    }
    await ui.unmount()
  })
}

test('a gh failure shows the reason and a refresh button', async ($, on) => {
  on('process.run', async () => ({ value: { exitCode: 1, stdout: '', stderr: 'HTTP 401: Bad credentials', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  await $.command.run({ command: 'deploys', args: '', origin: { kind: 'sdk' }, presentation: { isFullscreen: false, columns: 100 } })
  await settle()
  const ui = await $.ui.mount({ plugin: 'deploy-status', surface: 'desktop', ...PANE })
  expect((await ui.find({ type: 'Text', text: /Query failed/ }))?.text).toBe('Query failed: HTTP 401: Bad credentials')
  expect(await ui.find({ key: 'refresh' })).toBeDefined()
  await ui.unmount()
})
