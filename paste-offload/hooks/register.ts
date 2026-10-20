// paste-offload: a pasted block over the threshold goes to a file under
// ~/.claude/pastes/, and the prompt keeps its first lines plus the path.
// Everything sent stays in the conversation and is re-read on every later
// model call, so one 400k-character Wall-E debug dump is paid for again on
// each step after it; as a file, Claude reads only the part it needs.
//
// Fails open: if the file cannot be written the prompt goes through untouched,
// so a paste is never lost.

import type { EngineInterface, Register } from 'claude-code'

// The desktop app wraps each paste as <pasted_content id="...">...</pasted_content>.
const PASTE_BLOCK = /<pasted_content\b([^>]*)>\n?([\s\S]*?)\n?<\/pasted_content>/g
// Prompts typed or pasted by the person; not notifications, peers or plugins.
const PERSON_ORIGINS = new Set(['composer', 'bridge', 'sdk'])
const HEAD_CHARS_MAX = 4000

type Saved = { path: string; chars: number }

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function head(body: string, lines: number): string {
  const kept = body.split('\n').slice(0, lines).join('\n')
  return kept.length > HEAD_CHARS_MAX ? kept.slice(0, HEAD_CHARS_MAX) : kept
}

function stub(attrs: string, path: string, body: string, lines: number): string {
  const total = body.split('\n').length
  return (
    `<pasted_content${attrs} saved_to="${path}" chars="${body.length}" lines="${total}">\n` +
    `${head(body, lines)}\n` +
    `… [the full paste, ${body.length} characters in ${total} lines, is saved at ${path}; ` +
    'read the parts you need from that file]\n' +
    '</pasted_content>'
  )
}

async function save($: EngineInterface, dir: string, n: number, body: string): Promise<string> {
  const path = `${dir}/${stamp()}-${n}.txt`
  await $.fs.write(path, body)
  return path
}

export const register: Register = (on, options) => {
  const threshold = typeof options?.thresholdChars === 'number' ? options.thresholdChars : 20000
  const lines = typeof options?.headLines === 'number' ? options.headLines : 40

  on('prompt.submit', async ($, e, next) => {
    if (!PERSON_ORIGINS.has(e.origin.kind) || e.text.length <= threshold) return next(e)
    const home = await $.env.get('HOME')
    if (home === undefined) return next(e)
    const dir = `${home}/.claude/pastes`

    const saved: Saved[] = []
    try {
      let text: string
      const blocks = [...e.text.matchAll(PASTE_BLOCK)]
      if (blocks.length > 0) {
        // Replace each oversized block; the person's own words around them stay.
        const parts: string[] = []
        let last = 0
        for (const m of blocks) {
          const [whole, attrs = '', body = ''] = m
          const at = m.index ?? 0
          parts.push(e.text.slice(last, at))
          if (body.length > threshold) {
            const path = await save($, dir, saved.length, body)
            saved.push({ path, chars: body.length })
            parts.push(stub(attrs, path, body, lines))
          } else {
            parts.push(whole)
          }
          last = at + whole.length
        }
        parts.push(e.text.slice(last))
        text = parts.join('')
      } else {
        // No paste tags (a terminal paste, a long typed prompt): save it whole.
        const path = await save($, dir, 0, e.text)
        saved.push({ path, chars: e.text.length })
        text = stub('', path, e.text, lines)
      }
      if (saved.length === 0) return next(e)
      const chars = saved.reduce((sum, s) => sum + s.chars, 0)
      $.ui.toast(
        `已把 ${chars.toLocaleString('en-US')} 字的貼上存成檔案（${saved.length} 個），對話只留開頭 ${lines} 行：${saved[0]?.path ?? ''}`,
        { timeoutMs: 8000 },
      )
      return next({ ...e, text })
    } catch (error) {
      $.ui.log(`could not save the paste, sending it whole: ${String(error)}`)
      return next(e)
    }
  })
}
