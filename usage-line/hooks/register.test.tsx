import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, RenderElement, RenderPropsOf } from 'claude-code'

const NOW = Date.UTC(2026, 9, 16, 8, 0, 0)

const USAGE = {
  startedAt: NOW,
  context: { size: 200000, totalInputTokens: 0, totalOutputTokens: 0 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 26.4, resetsAt: new Date(NOW + 2 * 3_600_000 + 6 * 60_000).toISOString() },
    { kind: 'seven_day', percentUsed: 7, resetsAt: new Date(NOW + 2 * 86_400_000 + 3_600_000).toISOString() },
  ],
}

// 底層的 ui.render 會看到被改寫後的 modes——從這裡觀察結果
function world(on: On, usage: unknown, seen: string[][]) {
  mock.clock(on, { now: NOW })
  mock.store(on)
  on('session.usage', () => ({ value: usage as never }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('ui.render', ($, e) => {
    if (e.component === 'SessionMode') seen.push([...e.props.modes])
    const { Box } = $.ui.resolve(e)
    return h(Box, null) as RenderElement
  })
}

const MODE = {
  plugin: 'usage-line',
  surface: 'desktop',
  component: 'SessionMode',
  props: { modes: ['focus'] } as RenderPropsOf['SessionMode'],
} as const

describe('usage label in the prompt footer', () => {
  test('appends one usage label after the existing modes', async ($, on) => {
    const seen: string[][] = []
    world(on, USAGE, seen)
    await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: false })
    const ui = await $.ui.mount({ ...MODE })
    const last = seen.at(-1) ?? []
    expect(last[0]).toBe('focus')
    expect(last[1]).toContain('5h 26%')
    expect(last[1]).toContain('↻2h6m')
    expect(last[1]).toContain('7d 7%')
    expect(last[1]).toContain('↻2d1h')
    await ui.unmount()
  })

  test('no subscription data leaves the modes untouched', async ($, on) => {
    const seen: string[][] = []
    world(on, { ...USAGE, rateLimits: [] }, seen)
    await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: false })
    const ui = await $.ui.mount({ ...MODE })
    expect(seen.at(-1)).toEqual(['focus'])
    await ui.unmount()
  })
})
