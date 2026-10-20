import { atom, read, update } from 'claude-code'
import type { Register, EngineInterface } from 'claude-code'

import type { TaskForm, Mode, ExplainView } from '../types'

// Desktop app MCP server names (as /mcp lists them)
const SIDEBAR = 'ccd_sidebar'
const SESSIONS = 'ccd_session_mgmt'

// Classification design (after the Things 3 / Todoist / OmniFocus folder
// model): people are the stable folders (sidebar groups); time never gets a
// folder — the date goes into the title prefix, and time browsing is the
// app's own Group by date view.
//   person: person group, title = task
//   date:   no group, title = date · person · task (for the date view)
//   both:   person group, title = date · task (scan by date inside a group)
//   off:    never ask
// The mode switch lives in the composer toolbar; this plugin owns the mode
// state. Switching affects new sessions only; old ones are never re-filed.
// Person input follows the W3C combobox "recent values" pattern: a dropdown
// of previously used names plus "+ New name" to type a fresh one.
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

// Parse the first text block of an MCP tool result as JSON
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
    // If listing fails, just try to create the group
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

// -- Explain (formerly its own mod; merged so both share one toolbar row) --
// Modeled on the "select text -> floating explanation" popover pattern: the
// button sits by the composer; with a selection it explains the selection,
// otherwise the last reply. The answer comes from a $.model.fork side query
// and opens in the Explain panel; a real fork session continues the chat.
const EXPLAIN_PANE = 'explain'
const explainView = atom({ plugin: 'task-sort', key: 'explain' } as const, {
  kind: 'idle',
} as ExplainView)
// The full instruction staged by the fork buttons: when the user sends the
// short marker line, the prompt.submit hook attaches it as hidden context
// (the composer only ever shows one short sentence)
const forkArmed = atom({ plugin: 'task-sort', key: 'forkArmed' } as const, null as string | null)

// Line-style question-circle icon (matches the sidebar's line SVGs; no emoji)
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
    // A fork needs a conversation; with a selection, plain completion still works
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


// "Still unclear -> chat in a fork": a real fork only starts from words the
// user sent themselves (plugin-origin MCP calls are refused; plugin and even
// asUser submissions are downgraded to an offer card, and an accepted offer
// can only start fresh). To keep the composer short, the button fills one
// marker line; the full start_session instruction is staged in forkArmed and
// attached as hidden context by the prompt.submit hook.
const FORK_MARKER = 'Open the explain-chat fork.'

// Shared by both fork buttons: stage the instruction, draft the marker line
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

// Read the suggestions next-steps publishes to $.state (cross-plugin reads are allowed)
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
    'When I signal I am done or state a decision (in any language, e.g. "ok", "done", "go with A"), ',
    'close the loop: (1) reply with a one-line summary of my decision and the concrete ',
    'next steps; (2) relay it to the parent session with the send_message tool ',
    '(session_id "parent") in one short message: the decision, and what the parent ',
    'session should do next. ',
    'Write in the language I have been using.',
  ].join('')
  await armFork($, forkInstruction(forkPrompt))
}

// One-click fork explain: explain the last reply, walk through the next-step options, relay the decision to the parent
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
    'When I state a decision (in any language, e.g. "ok", "done", "option 2"), close the loop: ',
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

    // Note: desktop-app sessions are SDK-started, so e.isInteractive=false and
    // e.surface=null — never gate on them. The band only appears where a
    // surface draws AbovePrompt; headless runs draw nothing.
    if (mode !== 'off') {
      const id = await $.session.id()
      const classified = await getStore<Record<string, Entry>>($, 'classified', {})
      if (!classified[id]) {
        await update($, pending, () => true)
      }
    }

    return next(e)
  })

  // When the marker line is sent, attach the staged instruction as hidden context
  on('prompt.submit', async ($, e, next) => {
    const armed = await read($, forkArmed)
    if (armed === null) return next(e)
    await update($, forkArmed, () => null)
    if (!e.text.includes('explain-chat fork')) return next(e)
    return next({ ...e, context: [...(e.context ?? []), armed] })
  })

  // Toolbar: right-aligned against the composer's top edge, one row for the
  // Explain buttons and the Sort dropdown. (The desktop app does not draw
  // custom PromptHint trees and the footer takes plain text only, so this is
  // the lowest spot interactive controls can live; two plugins drawing two
  // stacked rows looked bad, hence one merged row.)
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

  // Explain panel: the chat button stays at the top (long explanations would push it out of view)
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

  // Stacks on top of other bands (e.g. next-steps) instead of replacing them:
  // take next(e) first, then append our rows (layout follows next-steps:
  // dim header plus indented content rows).
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
      // The picker shows a preselected name the user may never touch; fall back to it
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
