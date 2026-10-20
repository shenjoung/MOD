/* @jsxRuntime classic */
/* @jsx h */
/* @jsxFrag Fragment */
// deploy-status: /deploys opens a pane answering "is my change live?" for
// hourloop/guild without asking Claude: what prod (deploy.yml) and integ
// (integ-sync.yml / integ-deploy.yml) last deployed, which deploys are running
// now, and for each of my last five commits on main whether prod and integ
// include it (GitHub's compare: the deployed commit is ahead of or identical
// to mine).
//
// Read-only and on request: it runs `gh run list` / `gh api` GETs only when the
// pane opens or Refresh is pressed. It never polls, dispatches or reruns.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Deploy, MyCommit, Running, Snapshot } from '../types'

const PANE = 'deploy-status'
const COMMAND = 'deploys'
const snapshot = atom({ plugin: 'deploy-status', key: 'snapshot' } as const, null as Snapshot | null)

type Run = {
  status: string
  conclusion: string
  headSha: string
  headBranch: string
  createdAt: string
  event: string
  url: string
}

type Settings = { repo: string; gh: string }

const RUN_FIELDS = 'status,conclusion,headSha,headBranch,createdAt,event,url'

async function gh($: EngineInterface, s: Settings, args: string[]): Promise<unknown> {
  const r = await $.process.run([s.gh, ...args], { timeoutMs: 30000 })
  if (r.exitCode !== 0) throw new Error(r.stderr.trim().split('\n')[0] || `gh exited ${r.exitCode}`)
  return JSON.parse(r.stdout)
}

async function runs($: EngineInterface, s: Settings, workflow: string): Promise<(Run & { workflow: string })[]> {
  const list = (await gh($, s, ['run', 'list', '-R', s.repo, '--workflow', workflow, '--limit', '10', '--json', RUN_FIELDS])) as Run[]
  return list.map(run => ({ ...run, workflow }))
}

function lastSuccess(list: (Run & { workflow: string })[]): Deploy | null {
  const ok = list
    .filter(r => r.status === 'completed' && r.conclusion === 'success')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
  return ok === undefined
    ? null
    : { sha: ok.headSha, at: ok.createdAt, workflow: ok.workflow, event: ok.event, branch: ok.headBranch, url: ok.url }
}

// The deployed commit includes mine when it is ahead of it or the same commit.
async function includes($: EngineInterface, s: Settings, mine: string, deployed: Deploy | null): Promise<boolean | null> {
  if (deployed === null) return null
  try {
    const cmp = (await gh($, s, ['api', `repos/${s.repo}/compare/${mine}...${deployed.sha}`, '--jq', '{status: .status}'])) as { status: string }
    return cmp.status === 'ahead' || cmp.status === 'identical'
  } catch {
    return null
  }
}

async function collect($: EngineInterface, s: Settings): Promise<Snapshot> {
  const [prodRuns, syncRuns, integRuns, user] = await Promise.all([
    runs($, s, 'deploy.yml'),
    runs($, s, 'integ-sync.yml'),
    runs($, s, 'integ-deploy.yml'),
    gh($, s, ['api', 'user', '--jq', '{login: .login}']) as Promise<{ login: string }>,
  ])
  const prod = lastSuccess(prodRuns)
  const integ = lastSuccess([...syncRuns, ...integRuns])
  const running: Running[] = [...prodRuns, ...syncRuns, ...integRuns]
    .filter(r => r.status !== 'completed')
    .map(r => ({ workflow: r.workflow, status: r.status, sha: r.headSha, at: r.createdAt, url: r.url }))

  const raw = (await gh($, s, [
    'api',
    `repos/${s.repo}/commits?sha=main&author=${user.login}&per_page=5`,
    '--jq',
    '[.[] | {sha: .sha, at: .commit.author.date, title: (.commit.message | split("\\n")[0])}]',
  ])) as { sha: string; at: string; title: string }[]
  const commits: MyCommit[] = await Promise.all(
    raw.map(async c => ({
      ...c,
      onProd: await includes($, s, c.sha, prod),
      onInteg: await includes($, s, c.sha, integ),
    })),
  )
  return { kind: 'ready', at: new Date().toISOString(), repo: s.repo, login: user.login, prod, integ, running, commits }
}

async function refresh($: EngineInterface, s: Settings): Promise<void> {
  await update($, snapshot, () => ({ kind: 'loading' }))
  let next: Snapshot
  try {
    next = await collect($, s)
  } catch (error) {
    next = { kind: 'error', message: error instanceof Error ? error.message : String(error), at: new Date().toISOString() }
  }
  await update($, snapshot, () => next)
}

// Taipei time, MM/DD HH:MM; the environment has no Intl time zones to lean on.
function taipei(iso: string): string {
  const d = new Date(Date.parse(iso) + 8 * 3600 * 1000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
}

function mark(on: boolean | null): string {
  return on === null ? '?' : on ? 'live' : 'not live'
}

export const register: Register = (on, options) => {
  const s: Settings = {
    repo: typeof options?.repo === 'string' && options.repo !== '' ? options.repo : 'hourloop/guild',
    gh: typeof options?.gh === 'string' && options.gh !== '' ? options.gh : '/opt/homebrew/bin/gh',
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: COMMAND, description: 'Show prod / integ deploy status and whether my commits are live' })
    return next(e)
  })

  on('command.run', { command: COMMAND }, async $ => {
    await $.ui.open({ id: PANE, title: `Deploys · ${s.repo}` })
    void refresh($, s)
    return { text: 'Deploy status panel opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const snap = await read($, snapshot)

    const refreshButton = (
      <Button key="refresh" hotkey="r" label="Refresh" onPress={() => void refresh($, s)} />
    )
    if (snap === null || snap.kind === 'loading') {
      return (
        <Box flexDirection="column">
          <Text dimColor>Loading…</Text>
        </Box>
      )
    }
    if (snap.kind === 'error') {
      return (
        <Box flexDirection="column">
          <Text color="red">Query failed: {snap.message}</Text>
          <Box marginTop={1}>{refreshButton}</Box>
        </Box>
      )
    }

    const deployLine = (name: string, d: Deploy | null) => (
      <Text>
        <Text bold>{name.padEnd(6)}</Text>
        {d === null
          ? 'no successful deploy in the last 10 runs'
          : `${d.sha.slice(0, 9)}  ${taipei(d.at)}  ${d.workflow}${d.branch !== 'main' ? `（${d.branch}）` : ''}`}
      </Text>
    )

    return (
      <Box flexDirection="column">
        <Text dimColor>Updated {taipei(snap.at)} (Taipei)</Text>
        <Box marginTop={1} flexDirection="column">
          {deployLine('prod', snap.prod)}
          {deployLine('integ', snap.integ)}
        </Box>
        <Box marginTop={1} flexDirection="column">
          <Text bold>Running</Text>
          {snap.running.length === 0 ? (
            <Text dimColor>No deploy in progress</Text>
          ) : (
            snap.running.map((r, i) => (
              <Text>
                {r.workflow}  {r.status}  {r.sha.slice(0, 9)}  {taipei(r.at)}
              </Text>
            ))
          )}
        </Box>
        <Box marginTop={1} flexDirection="column">
          <Text bold>My recent commits on main ({snap.login})</Text>
          {snap.commits.length === 0 && <Text dimColor>none found</Text>}
          {snap.commits.map((c, i) => (
            <Text>
              {c.sha.slice(0, 9)}  integ {mark(c.onInteg)}  prod {mark(c.onProd)}  <Text dimColor>{taipei(c.at)} {c.title}</Text>
            </Text>
          ))}
        </Box>
        <Box marginTop={1}>{refreshButton}</Box>
      </Box>
    )
  })
}
