import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const BIG = Array.from({ length: 3000 }, (_, i) => `row ${i} ${'x'.repeat(20)}`).join('\n')
const SMALL = 'one\ntwo\nthree'

// What sits beneath the plugin: HOME, a file system that records writes (or
// refuses them), and a core that answers with the prompt that reached it.
function engine(on: On, opts: { refuseWrites?: boolean } = {}) {
  const writes: { path: string; text: string }[] = []
  const reached: string[] = []
  on('env.get', async () => ({ value: '/Users/test' }))
  on('fs.write', async (_$, e) => {
    if (opts.refuseWrites) return { deny: 'disk full' }
    writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('ui.toast', async () => ({ value: undefined }))
  on('ui.log', async () => ({ value: undefined }))
  on('prompt.submit', async (_$, e) => {
    reached.push(e.text)
    return { text: e.text }
  })
  return { writes, reached }
}

test('a big desktop paste is saved and only its head reaches the model', async ($, on) => {
  const { writes, reached } = engine(on)
  const text = `fix it\n\n<pasted_content id="8465">\n${BIG}\n</pasted_content>`
  await $.prompt.submit({ text, wait: false, origin: { kind: 'sdk' } })

  expect(writes).toHaveLength(1)
  expect(writes[0]?.text).toBe(BIG)
  expect(writes[0]?.path.startsWith('/Users/test/.claude/pastes/')).toBe(true)
  const sent = reached[0] ?? ''
  expect(sent.startsWith('fix it\n\n<pasted_content id="8465" saved_to="/Users/test/.claude/pastes/')).toBe(true)
  expect(sent).toContain('row 39 ')
  expect(sent.includes('row 40 ')).toBe(false)
  expect(sent.length < 6000).toBe(true)
})

test('a small paste beside a big one is left as it was', async ($, on) => {
  const { writes, reached } = engine(on)
  const small = `<pasted_content id="s">\n${SMALL}\n</pasted_content>`
  const text = `compare\n${small}\n<pasted_content id="b">\n${BIG}\n</pasted_content>`
  await $.prompt.submit({ text, wait: false, origin: { kind: 'sdk' } })
  expect(writes).toHaveLength(1)
  expect(reached[0]).toContain(small)
})

test('a terminal paste with no tags is saved whole', async ($, on) => {
  const { writes, reached } = engine(on)
  await $.prompt.submit({ text: BIG, wait: false, origin: { kind: 'composer' } })
  expect(writes[0]?.text).toBe(BIG)
  expect(reached[0]?.length ?? 0).toBeLessThan(6000)
})

test('short prompts, and prompts that are not the person own, pass untouched', async ($, on) => {
  const { writes, reached } = engine(on)
  await $.prompt.submit({ text: 'hello', wait: false, origin: { kind: 'sdk' } })
  await $.prompt.submit({ text: BIG, wait: false, origin: { kind: 'task-notification' } })
  expect(writes).toHaveLength(0)
  expect(reached).toEqual(['hello', BIG])
})

test('a refused write sends the paste whole rather than losing it', async ($, on) => {
  const { writes, reached } = engine(on, { refuseWrites: true })
  const text = `<pasted_content id="8465">\n${BIG}\n</pasted_content>`
  await $.prompt.submit({ text, wait: false, origin: { kind: 'sdk' } })
  expect(writes).toHaveLength(0)
  expect(reached).toEqual([text])
})
