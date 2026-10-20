import { atom, read, update } from 'claude-code'
import type { Register, EngineInterface } from 'claude-code'

import type { TaskForm, Mode, ExplainView } from '../types'

// 桌面 app 的 MCP server 名稱（/mcp 列表中的拼法）
const SIDEBAR = 'ccd_sidebar'
const SESSIONS = 'ccd_session_mgmt'

// 分類設計（參考 Things 3 / Todoist / OmniFocus 的資料夾模式）：
// 人名＝穩定的資料夾（sidebar 群組）；時間不開資料夾——日期放在標題前綴，
// 時間瀏覽交給 app 內建的 Group by date 檢視。
//   person：入人名群組，標題＝問題
//   date  ：不入群組，標題＝日期 · 人名 · 問題（配 app 的日期檢視用）
//   both  ：入人名群組，標題＝日期 · 問題（群組內按日期掃視）
//   off   ：不詢問
// 模式切換＝usage-line 的「Usage」卡裡的 segmented control（它讀本 plugin
// 的 mode state、透過 /task-sort 指令寫回，所以 state 的擁有者仍是這裡）。
// 只影響之後的新 session，舊的一律不動。
// 人名輸入＝W3C combobox「recent values」模式：選單列出輸入過的人名，
// 另有「＋ 新名字」切回文字輸入。
type Entry = { date: string; person: string; issue: string; skipped?: boolean }

const pending = atom({ plugin: 'task-sort', key: 'pending' } as const, false)
const form = atom({ plugin: 'task-sort', key: 'form' } as const, {
  person: '',
  issue: '',
  isNewPerson: false,
} as TaskForm)
const modeA = atom({ plugin: 'task-sort', key: 'mode' } as const, 'both' as Mode)

const MODES: readonly Mode[] = ['date', 'person', 'both', 'off']
const MODE_DESC: Record<Mode, string> = {
  person: 'person groups, title = task',
  date: 'no group, date-prefixed title (pair with sidebar Group by date)',
  both: 'person groups + date-prefixed title',
  off: 'off, new sessions are not asked',
}

function ymd(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

async function getStore<T>($: EngineInterface, key: string, fallback: T): Promise<T> {
  const v = await $.store.get(key)
  return (v ?? fallback) as T
}

async function setMode($: EngineInterface, next: Mode): Promise<void> {
  await $.store.set('mode', next)
  await update($, modeA, () => next)
}

// MCP 工具結果的第一個 text block 當 JSON 解析
function mcpJson(result: { content?: readonly unknown[] }): unknown {
  const blocks = (result.content ?? []) as { type?: string; text?: string }[]
  const text = blocks.find(b => b.type === 'text' && typeof b.text === 'string')?.text
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

async function ensureGroup($: EngineInterface, name: string): Promise<string | null> {
  try {
    const listed = mcpJson(await $.mcp.call(SIDEBAR, 'list_groups', {}))
    if (Array.isArray(listed)) {
      const hit = listed.find(g => g && (g as { name?: string }).name === name) as
        | { id?: string }
        | undefined
      if (hit?.id) return hit.id
    }
  } catch {
    // list 失敗就直接嘗試建立
  }
  try {
    const created = mcpJson(await $.mcp.call(SIDEBAR, 'create_group', { name }))
    if (created && typeof created === 'object' && 'id' in created) {
      return (created as { id: string }).id
    }
    if (typeof created === 'string') return created
  } catch (err) {
    $.ui.toast(`task-sort: creating group "${name}" failed: ${String(err)}`)
  }
  return null
}

function titleOf(mode: Mode, e: Entry): string {
  const issue = e.issue || '(untitled)'
  if (mode === 'person') return issue
  if (mode === 'both') return `${e.date} · ${issue}`
  return [e.date, e.person, issue].filter(Boolean).join(' · ')
}

async function classify($: EngineInterface, f: TaskForm): Promise<void> {
  const date = ymd(await $.clock.now())
  const entry: Entry = { date, person: f.person.trim(), issue: f.issue.trim() }
  const mode = await getStore<Mode>($, 'mode', 'both')

  try {
    await $.mcp.call(SESSIONS, 'set_session_title', {
      session_id: 'self',
      title: titleOf(mode, entry),
    })
  } catch (err) {
    $.ui.toast(`task-sort: renaming the session failed: ${String(err)}`)
  }

  if ((mode === 'person' || mode === 'both') && entry.person) {
    const groupId = await ensureGroup($, entry.person)
    if (groupId !== null) {
      try {
        await $.mcp.call(SIDEBAR, 'move_sessions', {
          session_ids: ['self'],
          group_id: groupId,
        })
      } catch (err) {
        $.ui.toast(`task-sort: filing into the group failed: ${String(err)}`)
      }
    }
  }

  const id = await $.session.id()
  const classified = await getStore<Record<string, Entry>>($, 'classified', {})
  classified[id] = entry
  await $.store.set('classified', classified)

  if (entry.person) {
    const people = await getStore<string[]>($, 'people', [])
    await $.store.set(
      'people',
      [entry.person, ...people.filter(p => p !== entry.person)].slice(0, 8),
    )
  }
}

async function dismiss($: EngineInterface): Promise<void> {
  await update($, pending, () => false)
  const id = await $.session.id()
  const classified = await getStore<Record<string, Entry>>($, 'classified', {})
  classified[id] = { date: ymd(Date.now()), person: '', issue: '', skipped: true }
  await $.store.set('classified', classified)
}

// ── Explain（原獨立 mod，10-16 併入以共用同一行工具列）────────────────
// 仿「選取文字 → 浮動解釋」popover 模式：按鈕在輸入框旁，有選取就解釋
// 選取內容、否則解釋上一則回覆；$.model.fork 側問取得，開右側「解釋」
// 小窗；看完還不懂可開一個 fork session 繼續聊。
const EXPLAIN_PANE = 'explain'
const explainView = atom({ plugin: 'task-sort', key: 'explain' } as const, {
  kind: 'idle',
} as ExplainView)
// 按下 fork 鈕後暫存的完整指令：使用者送出短句時由 prompt.submit hook
// 以隱形 context 附給模型（訊息框只留一句話）
const forkArmed = atom({ plugin: 'task-sort', key: 'forkArmed' } as const, null as string | null)

// 線條風格問號圈圈 icon（沿用側欄線條 SVG 風格，不用 emoji）
const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="#8b8b94" stroke-width="1.4" stroke-linecap="round"><circle cx="8" cy="8" r="6.3"/><path d="M6.1 6.1a1.9 1.9 0 1 1 2.7 1.7c-.55.3-.8.65-.8 1.3v.2"/><path d="M8 11.5v.01"/></svg>`

function replyPrompt(): string {
  return [
    'Explain your most recent reply so a complete non-expert can understand it. ',
    'List every knowledge point in it (terms, tools, mechanisms, numbers) — do not skip any. ',
    'For each, use one or two plain sentences: what it is, what role it plays here, and what the user needs to do about it (say "nothing" if nothing). ',
    'Use a bullet list. Simple but thorough. Output only the explanation, no preamble. ',
    "Write in the language the user has been using in this conversation.",
  ].join('')
}

function selectionPrompt(text: string): string {
  return [
    'Explain the selected content below so a complete non-expert can understand it. ',
    'List every knowledge point in it; for each, use one or two plain sentences: what it is, what it means, and what the user needs to do about it. ',
    'Use a bullet list. Simple but thorough. Output only the explanation, no preamble. ',
    'Write in the language the user has been using in this conversation; if there is no conversation yet, match the language of the selected text.',
    '\n\nSelected content:\n',
    text.slice(0, 6000),
  ].join('')
}

async function runExplain($: EngineInterface): Promise<void> {
  const current = await read($, explainView)
  if (current.kind === 'loading') return

  let selected = ''
  try {
    selected = (await $.ui.selection())?.text?.trim() ?? ''
  } catch {
    selected = ''
  }
  const target =
    selected !== '' ? `selection "${[...selected].slice(0, 40).join('')}…"` : 'the last reply'

  void $.ui.open({ id: EXPLAIN_PANE, title: 'Explain' }).catch(() => {})
  await update($, explainView, () => ({ kind: 'loading', target }) as ExplainView)

  try {
    let r = await $.model.fork({
      prompt: selected !== '' ? selectionPrompt(selected) : replyPrompt(),
    })
    // fork 要有對話才開得起來；有選取文字時退回一般 completion 照樣解釋
    if (!r.isAnswered && 'reason' in r && r.reason === 'nothing-to-fork') {
      if (selected !== '') {
        r = await $.model.complete({
          model: 'claude-sonnet-5-5',
          prompt: selectionPrompt(selected),
        })
      } else {
        await update($, explainView, () => ({ kind: 'empty' }) as ExplainView)
        return
      }
    }
    if (r.isAnswered) {
      await update($, explainView, () => ({ kind: 'done', target, text: r.text }) as ExplainView)
    } else {
      const why =
        'status' in r && r.status !== null
          ? `API ${r.status}`
          : 'reason' in r
            ? String(r.reason)
            : 'unknown error'
      await update($, explainView, () => ({ kind: 'error', message: why }) as ExplainView)
    }
  } catch (err) {
    await update($, explainView, () => ({ kind: 'error', message: String(err) }) as ExplainView)
  }
}


// 「還是不懂 → 開 fork 聊」：真 fork 只認使用者親自送出的話（plugin 直呼、
// plugin/asUser 代送全被降級；offer 卡只能開 fresh）。為了讓訊息框不要
// 一大串：按鈕只填一句短話，完整的 start_session 指令存進 forkArmed，
// 由 prompt.submit hook 用隱形 context（模型看得到、使用者看不到）附上。
const FORK_MARKER = 'Open the explain-chat fork.'

// 兩顆按鈕共用：把完整指令存進 forkArmed、短句填進輸入框
async function armFork($: EngineInterface, instruction: string): Promise<void> {
  try {
    const r = await $.prompt.fill({ text: FORK_MARKER, mode: 'replace' })
    if (r.isFilled) {
      await update($, forkArmed, () => instruction)
      $.ui.toast('Press Enter to open the explain-chat fork')
    } else {
      $.ui.toast('Could not fill the composer — type the request yourself')
    }
  } catch (err) {
    $.ui.toast(`Fork failed: ${String(err)}`)
  }
}

// 讀 next-steps 發布在 $.state 的目前建議（跨 plugin 讀取是允許的）
async function currentSuggestions($: EngineInterface): Promise<{ label: string; prompt: string }[]> {
  try {
    const got = (await $.state.get({ plugin: 'next-steps-desktop', key: 'suggestions' } as never)) as {
      value?: unknown
    }
    return Array.isArray(got?.value) ? (got.value as { label: string; prompt: string }[]) : []
  } catch {
    return []
  }
}

async function startChat($: EngineInterface, target: string): Promise<void> {
  const forkPrompt = [
    target === 'the last reply'
      ? 'Explain your latest reply before this fork '
      : `Explain the ${target} `,
    'so a complete non-expert gets it: list every knowledge point in plain words, ',
    'then keep chatting with me one concept at a time until I get it. ',
    'When I signal I am done or state a decision (e.g. "ok", "就這樣", "decided", "用 A"), ',
    'close the loop: (1) reply with a one-line summary of my decision and the concrete ',
    'next steps; (2) relay it to the parent session with the send_message tool ',
    '(session_id "parent") in one short message: the decision, and what the parent ',
    'session should do next. ',
    'Write in the language I have been using.',
  ].join('')
  await armFork($, forkInstruction(forkPrompt))
}

// 一鍵 fork explain：解釋上一則回覆＋逐一解釋 next-step 選項，決定後回傳 parent
async function startForkExplain($: EngineInterface): Promise<void> {
  const suggestions = await currentSuggestions($)
  const options =
    suggestions.length > 0
      ? `These next-step options are being offered to me right now: ${suggestions
          .map((s, i) => `${i + 1}) ${s.prompt}`)
          .join(' ')}. Explain what each option means and what it would do. `
      : 'Also lay out the likely next-step options from here and explain what each would do. '
  const forkPrompt = [
    'Explain your latest reply before this fork so a complete non-expert gets it: ',
    'list every knowledge point in plain words. ',
    options,
    'Then help me choose: chat with me one concept at a time. ',
    'When I state a decision (e.g. "ok", "就這樣", "decided", "選 2"), close the loop: ',
    '(1) reply with a one-line summary of my decision and the concrete next steps; ',
    '(2) relay it to the parent session with the send_message tool (session_id "parent") ',
    'in one short message: the decision, and what the parent session should do next. ',
    'Write in the language I have been using.',
  ].join('')
  await armFork($, forkInstruction(forkPrompt))
}

function forkInstruction(forkPrompt: string): string {
  return [
    'The user pressed the explain-fork button. Call mcp__ccd_session__start_session with ',
    'initiation "user_asked", context "fork", title "Explain chat" and prompt ',
    `${JSON.stringify(forkPrompt)}, then show it beside this window with open_session_in `,
    '(target "split"). Do nothing else; reply in one line.',
  ].join('')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'task-sort',
      description: 'Switch how new sessions are classified: date|person|both|off (old sessions untouched)',
      argumentHint: 'date|person|both|off',
    })
    await $.command.register({
      name: 'explain',
      description: 'Explain the last reply in plain words (or the selected text); opens the Explain panel',
    })

    const mode = await getStore<Mode>($, 'mode', 'both')
    await update($, modeA, () => mode)

    // 注意：桌面 app 的 session 由 SDK 啟動，e.isInteractive=false、
    // e.surface=null —— 不能拿它們當 gate。band 只在有 surface 畫 AbovePrompt
    // 時才出現，headless 跑不會畫。
    if (mode !== 'off') {
      const id = await $.session.id()
      const classified = await getStore<Record<string, Entry>>($, 'classified', {})
      if (!classified[id]) {
        await update($, pending, () => true)
      }
    }

    return next(e)
  })

  // fork 短句送出時，把完整指令以隱形 context 附給模型（使用者只看到短句）
  on('prompt.submit', async ($, e, next) => {
    const armed = await read($, forkArmed)
    if (armed === null) return next(e)
    await update($, forkArmed, () => null)
    if (!e.text.includes('explain-chat fork')) return next(e)
    return next({ ...e, context: [...(e.context ?? []), armed] })
  })

  // 工具列：貼著輸入框上緣、靠右，一行放完 ⍰ Explain 和 Sort 下拉
  // （桌面版不畫 PromptHint 自訂樹，footer 只收純文字標籤——互動元件
  // 能放的最低位置就是這裡；之前分兩個 plugin 各畫一行被嫌醜，合併成一行）。
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey || e.surface === 'mobile') return below
    const { Box, Button, Select } = $.ui.resolve(e)
    const mode = await read($, modeA)
    const icon =
      e.surface === 'terminal'
        ? null
        : (() => {
            const { Svg } = $.ui.resolve(e)
            return <Svg source={ICON} alt="explain" width={12} height={12} />
          })()

    return (
      <Box flexDirection="column">
        {below}
        <Box gap={1} alignItems="center" justifyContent="flex-end">
          {icon}
          <Button
            key="explain"
            label="Explain"
            plain
            dimColor
            onPress={() => void runExplain($).catch(() => {})}
          />
          <Button
            key="explain-fork"
            label="Explain in fork"
            plain
            dimColor
            onPress={() => void startForkExplain($).catch(() => {})}
          />
          <Box marginLeft={1}>
            <Select
              key="sort-mode"
              label="Sort"
              value={mode}
              options={[
                { label: 'Date', value: 'date' },
                { label: 'Person', value: 'person' },
                { label: 'Both', value: 'both' },
                { label: 'Off', value: 'off' },
              ]}
              onSelect={async v => {
                if (MODES.includes(v as Mode)) {
                  await setMode($, v as Mode)
                  $.ui.toast(`task-sort: ${v} — ${MODE_DESC[v as Mode]}`)
                }
              }}
            />
          </Box>
        </Box>
      </Box>
    )
  })

  // 「解釋」小窗：聊天鈕固定在頂部（解釋很長時不用捲到底才看得到）
  on('ui.render', { component: 'Pane', requestId: EXPLAIN_PANE }, async ($, e) => {
    const { Box, Text, Markdown, Button } = $.ui.resolve(e)
    const v = await read($, explainView)

    return (
      <Box flexDirection="column" paddingX={1} rowGap={1}>
        {v.kind === 'idle' && (
          <Text dimColor>Press Explain next to the composer (or /explain) to generate one.</Text>
        )}
        {v.kind === 'empty' && (
          <Text dimColor>Nothing to explain yet — send a message first, then press Explain after the reply.</Text>
        )}
        {v.kind === 'loading' && <Text dimColor>Explaining {v.target}…</Text>}
        {v.kind === 'error' && <Text color="red">Explain failed: {v.message}</Text>}
        {v.kind === 'done' && (
          <Box flexDirection="column" rowGap={1}>
            <Box gap={2} alignItems="center">
              <Button
                key="chat"
                label="Still unclear? Chat in a fork"
                variant="primary"
                onPress={() => void startChat($, v.target).catch(() => {})}
              />
              <Button
                key="clear"
                label="Clear"
                plain
                dimColor
                onPress={() => update($, explainView, () => ({ kind: 'idle' }) as ExplainView)}
              />
            </Box>
            <Text dimColor>About: {v.target}</Text>
            <Markdown text={v.text} />
          </Box>
        )}
      </Box>
    )
  })

  on('command.run', { command: 'explain' }, async $ => {
    void runExplain($).catch(() => {})
    return { text: 'Explaining — see the Explain panel on the right.' }
  })

  // 疊在其他 band（如 next-steps）之上，不取代它們：先 next(e) 拿下層內容，
  // 再把自己的一列排在下面（版式沿用 next-steps：淡色標題＋縮排內容列）。
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (
      !(await read($, pending)) ||
      e.props.hasSurvey ||
      e.props.isWorking ||
      e.surface === 'mobile'
    ) {
      return below
    }

    const f = await read($, form)
    const people = await getStore<string[]>($, 'people', [])
    const { Box, Text, Input, Select, Button } = $.ui.resolve(e)
    const usePicker = people.length > 0 && !f.isNewPerson

    const submit = async () => {
      const cur = await read($, form)
      // 選單顯示預選值但使用者沒動過時，form.person 還是空字串——補上預選值
      const person = cur.person || (usePicker ? (people[0] ?? '') : '')
      await update($, pending, () => false)
      await classify($, { ...cur, person })
    }

    return (
      <Box flexDirection="column">
        {below}
        <Box marginTop={1} />
        <Text dimColor>Classify · {ymd(Date.now())}</Text>
        <Box marginLeft={2} marginTop={1} gap={2} alignItems="center">
          {usePicker ? (
            <Select
              key="person-pick"
              label="Person"
              value={f.person || people[0]}
              autoFocus
              options={[
                ...people.map(p => ({ label: p, value: p })),
                { label: '+ New name', value: '__new__' },
              ]}
              onSelect={v =>
                v === '__new__'
                  ? update($, form, cur => ({ ...cur, person: '', isNewPerson: true }))
                  : update($, form, cur => ({ ...cur, person: v }))
              }
            />
          ) : (
            <Box minWidth={20}>
              <Input
                key="person"
                label="Person"
                placeholder="e.g. joanne"
                value={f.person}
                autoFocus
                onInput={v => update($, form, cur => ({ ...cur, person: v }))}
                onSubmit={v => update($, form, cur => ({ ...cur, person: v }))}
              />
            </Box>
          )}
          <Box flexGrow={1}>
            <Input
              key="issue"
              label="Task"
              placeholder="What is this session for?"
              value={f.issue}
              onInput={v => update($, form, cur => ({ ...cur, issue: v }))}
              onSubmit={async v => {
                await update($, form, cur => ({ ...cur, issue: v }))
                await submit()
              }}
            />
          </Box>
        </Box>
        <Box marginLeft={2} marginTop={1} gap={2}>
          <Button key="create" label="Create" variant="primary" onPress={submit} />
          <Button
            key="skip"
            hotkey="0"
            label="Skip"
            plain
            dimColor
            role="dismiss"
            onPress={() => dismiss($)}
          />
        </Box>
      </Box>
    )
  })

  on('command.run', { command: 'task-sort' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const mode = await getStore<Mode>($, 'mode', 'both')

    if (arg === '') {
      return {
        text: [
          `task-sort current mode: ${mode} (${MODE_DESC[mode]})`,
          ...MODES.map(m => `  /task-sort ${m} — ${MODE_DESC[m]}`),
        ].join('\n'),
      }
    }
    if (!MODES.includes(arg as Mode)) {
      return { text: `task-sort: unknown "${arg}" — use date|person|both|off` }
    }

    await setMode($, arg as Mode)
    return {
      text: `task-sort: mode set to ${arg} (${MODE_DESC[arg as Mode]}). New sessions only; old ones stay put.`,
    }
  })
}
