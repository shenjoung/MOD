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
    expect((await ui.find({ key: 'dismiss' }))?.props.label).toBe('Dismiss')
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

for (const surface of ['terminal', 'desktop'] as const) {
  test(`Send submits a suggestion as the person's own prompt on ${surface}`, async ($, on) => {
    const submitted: { text: string; origin: unknown }[] = []
    engine(on)
    on('model.fork', async () => ({ value: FORK_REPLY }))
    on('prompt.suggest', async () => ({ isShown: true }))
    on('prompt.submit', async (_$, e) => {
      submitted.push({ text: e.text, origin: e.origin })
      return { text: e.text }
    })

    const ui = await $.ui.mount({ plugin: PLUGIN, surface, ...BAND })
    await $.turn.complete({ answer: ANSWER, durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' })
    await settle()
    expect(submitted).toHaveLength(0) // nothing is sent without a press

    await ui.press({ key: 'send2' })
    expect(submitted).toHaveLength(1)
    expect(submitted[0]?.text).toBe('update docs/worktime.md for this change')
    expect(submitted[0]?.origin).toMatchObject({ kind: 'plugin', asUser: true })
    expect(await ui.find({ key: 'send1' })).toBeUndefined()
    await ui.unmount()
  })
}

test("the prompt box's own suggestion gets a Send button too", async ($, on) => {
  const submitted: string[] = []
  engine(on)
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  on('prompt.suggest', async () => ({ isShown: true }))
  on('prompt.submit', async (_$, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...BAND })
  // Claude Code's own guess at the next prompt, shown dim in the box.
  await $.prompt.suggest({ text: 'commit and push this', origin: { kind: 'suggestion' } })
  expect((await ui.find({ type: 'Text', text: /Suggested: commit and push this/ }))).toBeDefined()

  await ui.press({ key: 'send-ghost' })
  expect(submitted).toEqual(['commit and push this'])
  expect(await ui.find({ key: 'send-ghost' })).toBeUndefined()

  // A new turn clears it.
  await $.prompt.suggest({ text: 'run the tests', origin: { kind: 'suggestion' } })
  await $.turn.start({ turnId: 't9' } as never)
  expect(await ui.find({ key: 'send-ghost' })).toBeUndefined()
  await ui.unmount()
})
