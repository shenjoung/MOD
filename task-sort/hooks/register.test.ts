import { describe, expect, mock, test } from 'claude-code/testing'
import type { CommandRunInput, On, RenderElement, RenderPropsOf } from 'claude-code'

// 測試裡 $.command.run 只需要 command + args；補齊型別用
const runArgs = (args: string) =>
  ({ command: 'task-sort', args }) as unknown as CommandRunInput

// 測試世界的底層：記憶體 store/clock，加上引擎在測試裡沒有實作的幾個 op
function world(on: On, entries?: Readonly<Record<string, unknown>>) {
  mock.store(on, entries)
  mock.clock(on, { now: Date.UTC(2026, 9, 14, 8, 0, 0) })
  on('session.id', () => ({ value: 'test-session' }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('ui.open', () => ({ value: { isPlaced: true } as never }))
  on('ui.toast', () => ({ value: undefined as never }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return h(Box, null) as RenderElement
  })
}

describe('task-sort command', () => {
  test('unknown argument is rejected', async ($, on) => {
    world(on)
    const out = await $.command.run(runArgs('bogus'))
    expect(out.text).toContain('unknown')
  })

  test('no argument reports the current mode', async ($, on) => {
    world(on)
    const out = await $.command.run(runArgs(''))
    expect(out.text).toContain('current mode: both')
  })

  test('off persists and is reported back', async ($, on) => {
    world(on)
    const set = await $.command.run(runArgs('off'))
    expect(set.text).toContain('mode set to off')
    const out = await $.command.run(runArgs(''))
    expect(out.text).toContain('current mode: off')
  })

  test('mode change only affects new sessions', async ($, on) => {
    world(on)
    const out = await $.command.run(runArgs('person'))
    expect(out.text).toContain('mode set to person')
    expect(out.text).toContain('New sessions only')
  })
})

describe('task-sort sort dropdown', () => {
  test('picking a mode from the composer dropdown switches it', async ($, on) => {
    world(on)
    await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: false })
    const ui = await $.ui.mount({
      plugin: 'task-sort',
      surface: 'desktop',
      component: 'AbovePrompt',
      props: { hasSurvey: false } as RenderPropsOf['AbovePrompt'],
    })
    expect(await ui.find({ key: 'sort-mode' })).toBeDefined()
    await ui.select({ key: 'sort-mode', value: 'person' })
    const out = await $.command.run(runArgs(''))
    expect(out.text).toContain('current mode: person')
    await ui.unmount()
  })
})

describe('explain in fork (one-click)', () => {
  test('drafts the marker and arms an instruction covering next-step options', async ($, on) => {
    explainWorld(on, {})
    on('state.get' as never, ((_$, e, next) => next(e)) as never)
    const fills: { text: string }[] = []
    on('prompt.fill', (_$, e) => {
      fills.push(e as { text: string })
      return { isFilled: true } as never
    })
    let seenContext: readonly string[] | undefined
    on('prompt.submit', (_$, e) => {
      seenContext = (e as { context?: readonly string[] }).context
      return { text: (e as { text: string }).text } as never
    })
    const band = await $.ui.mount({ ...EXPLAIN_BAND })
    expect(await band.find({ key: 'explain-fork' })).toBeDefined()
    await band.press({ key: 'explain-fork' })
    await band.unmount()
    expect(fills.length).toBe(1)
    await $.prompt.submit({ text: 'Open the explain-chat fork.' })
    const joined = (seenContext ?? []).join(' ')
    expect(joined).toContain('context "fork"')
    expect(joined).toContain('next-step')
    expect(joined).toContain('send_message')
  })
})

describe('task-sort band', () => {
  test('band hidden until a session start marks it pending', async ($, on) => {
    world(on)
    const ui = await $.ui.mount({
      plugin: 'task-sort',
      surface: 'desktop',
      component: 'AbovePrompt',
      props: { hasSurvey: false } as RenderPropsOf['AbovePrompt'],
    })
    expect(await ui.find({ key: 'create' })).toBeUndefined()
    await ui.unmount()
  })

  test('session start shows the band; skip dismisses and marks it', async ($, on) => {
    world(on)
    await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({
      plugin: 'task-sort',
      surface: 'desktop',
      component: 'AbovePrompt',
      props: { hasSurvey: false } as RenderPropsOf['AbovePrompt'],
    })
    expect(await ui.find({ key: 'create' })).toBeDefined()
    await ui.press({ key: 'skip' })
    expect(await ui.find({ key: 'create' })).toBeUndefined()
    await ui.unmount()

    // 略過要記進 store：同一個 session 再 start 一次不會再被問
    await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
    const again = await $.ui.mount({
      plugin: 'task-sort',
      surface: 'desktop',
      component: 'AbovePrompt',
      props: { hasSurvey: false } as RenderPropsOf['AbovePrompt'],
    })
    expect(await again.find({ key: 'create' })).toBeUndefined()
    await again.unmount()
  })

  test('untouched picker still files under the preselected person', async ($, on) => {
    // 自建記憶體 store（不用 mock.store），才能觀察寫入內容
    const db: Record<string, unknown> = { people: ['joanne'] }
    mock.clock(on, { now: Date.UTC(2026, 9, 14, 8, 0, 0) })
    on('store.get', (_$, e) => ({ value: (db[(e as { key: string }).key] ?? null) as never }))
    on('store.set', (_$, e) => {
      const { key, value } = e as { key: string; value: unknown }
      db[key] = value
      return { value: undefined as never }
    })
    on('session.id', () => ({ value: 'test-session' }))
    on('command.register', (_$, e) => ({ value: { command: e.name } }))
    on('session.start', (_$, e) => ({ cwd: e.cwd }))
    on('ui.open', () => ({ value: { isPlaced: true } as never }))
    on('ui.toast', () => ({ value: undefined as never }))
    on('ui.render', ($, e) => {
      const { Box } = $.ui.resolve(e)
      return h(Box, null) as RenderElement
    })
    await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({
      plugin: 'task-sort',
      surface: 'desktop',
      component: 'AbovePrompt',
      props: { hasSurvey: false } as RenderPropsOf['AbovePrompt'],
    })
    expect(await ui.find({ key: 'person-pick' })).toBeDefined()
    await ui.press({ key: 'create' })
    expect(JSON.stringify(db['classified'] ?? {})).toContain('joanne')
    await ui.unmount()
  })

  test('an already-classified session is not asked again', async ($, on) => {
    world(on, {
      classified: { 'test-session': { date: '10-14', person: 'Sam', issue: 'x' } },
    })
    await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({
      plugin: 'task-sort',
      surface: 'desktop',
      component: 'AbovePrompt',
      props: { hasSurvey: false } as RenderPropsOf['AbovePrompt'],
    })
    expect(await ui.find({ key: 'create' })).toBeUndefined()
    await ui.unmount()
  })
})

// ── Explain（併入 task-sort 後的測試）──────────────────────────────
function explainWorld(
  on: On,
  opts: { selection?: string; forkEmpty?: boolean; mcpCalls?: { server: string; tool: string; args?: Record<string, unknown> }[] },
) {
  world(on)
  on('ui.selection', () => ({
    value: (opts.selection !== undefined ? { text: opts.selection } : undefined) as never,
  }))
  on('model.fork', () => ({
    value: (opts.forkEmpty
      ? { isAnswered: false, reason: 'nothing-to-fork' }
      : { isAnswered: true, text: '- 解釋點一\n- 解釋點二', usage: {} }) as never,
  }))
  if (opts.mcpCalls) {
    const calls = opts.mcpCalls
    on('mcp.call', (_$, e) => {
      calls.push(e as never)
      return {
        value: { content: [{ type: 'text', text: '{"session_id":"local_abc-123"}' }] } as never,
      }
    })
  }
}

const EXPLAIN_BAND = {
  plugin: 'task-sort',
  surface: 'desktop',
  component: 'AbovePrompt',
  props: { hasSurvey: false } as RenderPropsOf['AbovePrompt'],
} as const

const EXPLAIN_PANE = {
  plugin: 'task-sort',
  surface: 'desktop',
  component: 'Pane',
  requestId: 'explain',
  props: {} as RenderPropsOf['Pane'],
} as const

describe('explain (merged)', () => {
  test('chat button drafts a short marker; sending attaches hidden instructions', async ($, on) => {
    explainWorld(on, {})
    const fills: { text: string }[] = []
    on('prompt.fill', (_$, e) => {
      fills.push(e as { text: string })
      return { isFilled: true } as never
    })
    let seenContext: readonly string[] | undefined
    on('prompt.submit', (_$, e) => {
      seenContext = (e as { context?: readonly string[] }).context
      return { text: (e as { text: string }).text } as never
    })
    const band = await $.ui.mount({ ...EXPLAIN_BAND })
    await band.press({ key: 'explain' })
    await band.unmount()
    const pane = await $.ui.mount({ ...EXPLAIN_PANE })
    await pane.press({ key: 'chat' })
    expect(fills.length).toBe(1)
    expect((fills[0]?.text ?? '').length < 60).toBe(true)
    await pane.unmount()

    // 使用者按 Enter（這裡模擬送出同一句短話）→ 隱形 context 應帶完整指令
    await $.prompt.submit({ text: 'Open the explain-chat fork.' })
    const joined = (seenContext ?? []).join(' ')
    expect(joined).toContain('context "fork"')
    expect(joined).toContain('initiation "user_asked"')
    expect(joined).toContain('send_message')
    expect(joined).toContain('parent')

    // 第二次送出（flag 已清）不再附加
    seenContext = undefined
    await $.prompt.submit({ text: 'Open the explain-chat fork.' })
    expect((seenContext ?? []).length).toBe(0)
  })

  test('toolbar has Explain and Sort on one row; press explains into the pane', async ($, on) => {
    explainWorld(on, {})
    const band = await $.ui.mount({ ...EXPLAIN_BAND })
    expect(await band.find({ key: 'explain' })).toBeDefined()
    expect(await band.find({ key: 'sort-mode' })).toBeDefined()
    await band.press({ key: 'explain' })
    await band.unmount()

    const pane = await $.ui.mount({ ...EXPLAIN_PANE })
    expect(await pane.find({ type: 'Markdown' })).toBeDefined()
    expect(await pane.find({ key: 'chat' })).toBeDefined()
    await pane.unmount()
  })

  test('no reply yet shows a friendly note', async ($, on) => {
    explainWorld(on, { forkEmpty: true })
    const band = await $.ui.mount({ ...EXPLAIN_BAND })
    await band.press({ key: 'explain' })
    await band.unmount()
    const pane = await $.ui.mount({ ...EXPLAIN_PANE })
    expect(await pane.find({ type: 'Text', text: /Nothing to explain/ })).toBeDefined()
    await pane.unmount()
  })

})
