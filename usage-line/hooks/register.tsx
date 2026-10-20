import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Limit } from '../types'

// Usage under the composer: one dim line on the PromptHint row (the line
// below the prompt box), styled after cc-statusline's single-line quota
// layout — `5h 26% ↻2h0m · 7d 7% ↻11h20m`, percent colored by load.
// Data comes from the engine's own rate-limit readings (same as /usage).
// Composes with the engine's own hint (and other plugins) via next(e).
const limits = atom({ plugin: 'usage-line', key: 'limits' } as const, [] as Limit[])

const LABEL: Record<string, string> = { five_hour: '5h', seven_day: '7d' }

function pctColor(pct: number): 'green' | 'yellow' | 'red' {
  if (pct >= 80) return 'red'
  if (pct >= 50) return 'yellow'
  return 'green'
}

function resetSpan(iso: string | undefined, now: number): string {
  if (!iso) return ''
  const left = Date.parse(iso) - now
  if (!Number.isFinite(left) || left <= 0) return ''
  const d = Math.floor(left / 86_400_000)
  const h = Math.floor((left % 86_400_000) / 3_600_000)
  const m = Math.floor((left % 3_600_000) / 60_000)
  return ` ↻${d > 0 ? `${d}d${h}h` : `${h}h${m}m`}`
}

async function refresh($: EngineInterface): Promise<void> {
  const usage = await $.session.usage()
  await update($, limits, () =>
    usage.rateLimits.filter(rl => rl.kind in LABEL).map(rl => ({ ...rl })),
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await refresh($)
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) {
      await update($, limits, () =>
        e.rateLimits.filter(rl => rl.kind in LABEL).map(rl => ({ ...rl })),
      )
    }
    return next(e)
  })

  // 桌面版不畫 PromptHint 自訂樹；真正固定顯示在輸入框下方的是 footer 的
  // SessionMode 標籤列（「Fable 5 Medium」那排）——把用量加成一個標籤。
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const list = await read($, limits)
    if (list.length === 0) return next(e)
    const now = await $.clock.now()
    const label = list
      .map(rl => {
        const pct = Math.round(rl.percentUsed)
        return `${LABEL[rl.kind]} ${pct}%${resetSpan(rl.resetsAt, now)}`
      })
      .join(' · ')
    return next({ ...e, props: { ...e.props, modes: [...e.props.modes, label] } } as typeof e)
  })
}
