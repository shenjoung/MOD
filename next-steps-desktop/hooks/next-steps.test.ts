import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const PLUGIN = 'next-steps-desktop'
const ANSWER = 'Done. I added the three tests to tests/test_worktime.py and they pass locally; the docs are untouched.'
const REPLY = JSON.stringify([
  { label: 'run the full suite', prompt: 'run the full test suite' },
  { label: 'update the docs', prompt: 'update docs/worktime.md for this change' },
])
const FORK_REPLY = {
  isAnswered: true,
  text: REPLY,
  usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
} as const
const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 20,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 19 },
    view: {},
  },
} as const

// The plugin asks the fork detached from turn.complete; give it a few turns
// of the event loop to land before reading the band.
async function settle(): Promise<void> {
  for (let i = 0; i < 200; i++) await Promise.resolve()
}

// What the engine itself answers beneath the plugin: an empty band, and the
// turn's answer as its own text, and no skills or slash commands.
function engine(on: On): void {
  on('ui.render', async ($, e) => $.ui.resolve(e).Box({}))
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  on('command.list', async () => ({ value: [] }))
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`suggestions draw and fill the prompt box on ${surface}`, async ($, on) => {
    let forks = 0
    const filled: string[] = []
    const forkPrompts: string[] = []
    engine(on)
    on('model.fork', async (_$, e) => {
      forkPrompts.push(e.prompt)
      forks++
      return { value: FORK_REPLY }
    })
    on('prompt.fill', async (_$, e) => {
      filled.push(e.text)
      return { isFilled: true }
    })
    on('prompt.suggest', async () => ({ isShown: true }))

    const ui = await $.ui.mount({ plugin: PLUGIN, surface, ...BAND })
    await $.turn.complete({ answer: ANSWER, durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' })
    await settle()

    expect(forks).toBe(1)
    expect((await ui.find({ key: 's1' }))?.props.label).toBe('run the full suite')
    expect((await ui.find({ key: 's2' }))?.props.label).toBe('update the docs')
    expect((await ui.find({ key: 'dismiss' }))?.props.role).toBe('dismiss')
    expect((await ui.find({ key: 'dismiss' }))?.props.label).toBe('×')
    expect(forkPrompts[0]).toContain('the language the user has been writing in')

    await ui.press({ key: 's2' })
    expect(filled).toEqual(['update docs/worktime.md for this change'])
    expect(await ui.find({ key: 's1' })).toBeUndefined()
    await ui.unmount()
  })
}

test('a subagent turn does not fork', async ($, on) => {
  let forks = 0
  engine(on)
  on('model.fork', async () => {
    forks++
    return { value: FORK_REPLY }
  })
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...BAND })
  await $.turn.complete({ answer: ANSWER, durationMs: 1000, isAborted: false, turnId: 't2', reason: 'answer', agentId: 'a1' })
  await settle()
  expect(forks).toBe(0)
  expect(await ui.find({ key: 's1' })).toBeUndefined()
  await ui.unmount()
})

test('long labels are shown as a gist; the press fills the full prompt', async ($, on) => {
  const filled: string[] = []
  engine(on)
  on('model.fork', async () => ({
    value: {
      ...FORK_REPLY,
      text: JSON.stringify([
        {
          label: 'update the worktime documentation for the new tests',
          prompt: 'update docs/worktime.md for this change',
        },
      ]),
    },
  }))
  on('prompt.suggest', async () => ({ isShown: true }))
  on('prompt.fill', async (_$, e) => {
    filled.push(e.text)
    return { isFilled: true }
  })
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...BAND })
  await $.turn.complete({ answer: ANSWER, durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' })
  await settle()
  const label = (await ui.find({ key: 's1' }))?.props.label as string
  expect(label.length <= 28).toBe(true)
  expect(label.endsWith('…')).toBe(true)
  await ui.press({ key: 's1' })
  expect(filled).toEqual(['update docs/worktime.md for this change'])
  await ui.unmount()
})
