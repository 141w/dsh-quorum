/**
 * Read a live round's durable transcript and print the lines that are evidence,
 * in the raw form the discipline claims: tool calls, tool results, denials, and
 * the billed totals per member.
 *
 * Why a script instead of eyeballing the file: every quoted line that lands in
 * `docs/verification.md` has to come from the committed log, not from what the
 * Lead's final message says happened. The whole point of the evidence gate is
 * that a confident restatement is not proof, and that applies to this repo's own
 * documentation exactly as much as it applies to a teammate.
 *
 * Usage:
 *   node .probe/read-live-round.mjs [workspaceSlug] [--grep pattern] [--tail N]
 *
 * Default slug is the live-test workspace this project rounds against.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? fallback : args[at + 1]
}
const slug = args[0] && !args[0].startsWith('--')
  ? args[0]
  : '--Users-wweiqi-Documents-deepseek-harness-default-workspace--'
const needle = flag('grep', null)
const tail = Number(flag('tail', 0))

const ZSTD = join(homedir(), 'miniconda3/bin/zstd')
const sessionsRoot = join(homedir(), '.dsh/sessions', slug)
if (!existsSync(sessionsRoot)) {
  console.error(`no session directory for ${sessionsRoot}`)
  console.error('slugs available:')
  for (const dir of readdirSync(join(homedir(), '.dsh/sessions'))) console.error(`  ${dir}`)
  process.exit(2)
}

const decode = (path) => execFileSync(ZSTD, ['-dc', path], { maxBuffer: 1 << 28 }).toString()

const readEvents = (dir) => {
  const files = readdirSync(dir).filter((f) => f.endsWith('session.v4.jsonl.zstd'))
  if (!files.length) return { events: [], file: null }
  const file = join(dir, files[0])
  const events = decode(file)
    .split('\n')
    .filter(Boolean)
    .map((line) => { try { return JSON.parse(line) } catch { return null } })
    .filter(Boolean)
  return { events, file }
}

const billed = (usage) => Number(usage?.inputTokens ?? 0) + Number(usage?.outputTokens ?? 0)
  + Number(usage?.cacheReadTokens ?? 0) + Number(usage?.cacheWriteTokens ?? 0)

const sessions = readdirSync(sessionsRoot)
  .filter((name) => statSync(join(sessionsRoot, name)).isDirectory())
  .map((name) => {
    const dir = join(sessionsRoot, name)
    const { events, file } = readEvents(dir)
    const headerFile = join(dir, 'header.json')
    let header = {}
    try { header = JSON.parse(readFileSync(headerFile, 'utf8')) } catch { /* older or partial session */ }
    let usage = 0
    let calls = 0
    for (const event of events) {
      if (event.type === 'assistant/message') usage += billed(event.data?.message?.usage ?? event.data?.usage)
      if (event.type === 'tool/call') calls += 1
    }
    const newest = events.length ? events[events.length - 1].time ?? 0 : 0
    return { name, header, events, file, usage, calls, newest }
  })
  .sort((a, b) => b.newest - a.newest)

if (!sessions.length) {
  console.error(`no sessions under ${sessionsRoot}`)
  process.exit(2)
}

console.log('# sessions, newest first')
for (const s of sessions.slice(0, 8)) {
  const when = s.newest ? new Date(s.newest).toLocaleString('sv') : '-'
  console.log(`  ${when}  ${String(s.usage).padStart(9)} billed  ${String(s.calls).padStart(3)} calls  ${s.name}  ${s.header?.name ?? ''}`)
}

const target = sessions[0]
console.log(`\n# transcript read: ${target.file}`)
console.log(`# events: ${target.events.length}, billed: ${target.usage}, title: ${target.header?.name ?? '(none)'}`)

const names = new Map()
for (const event of target.events) {
  if (event.type === 'tool/call' && event.data?.callId) names.set(event.data.callId, event.data.name)
}

const text = (message) => (typeof message?.content === 'string' ? message.content
  : (message?.content ?? []).map((part) => part?.text ?? '').join(' '))

const lines = []
for (const event of target.events) {
  if (event.type === 'tool/call') {
    lines.push(`seq ${event.seq} CALL   ${event.data?.name} ${String(event.data?.arguments ?? '').slice(0, 160)}`)
  } else if (event.type === 'tool/result') {
    const name = names.get(event.data?.message?.toolCallId) ?? '?'
    const body = text(event.data?.message).replace(/\s+/g, ' ').slice(0, 420)
    lines.push(`seq ${event.seq} ${event.data?.message?.isError ? 'ERROR' : ' OK  '} ${name} :: ${body}`)
  } else if (event.type === 'team/message/queued' || event.type === 'team/message/delivered') {
    const m = event.data?.message ?? event.data
    lines.push(`seq ${event.seq} ${event.type.toUpperCase()} from ${m?.senderName ?? '?'} → ${m?.targetId ?? '?'}`)
  } else if (event.type === 'agent/inbox/spliced') {
    lines.push(`seq ${event.seq} INBOX  ${text({ content: event.data?.content ?? event.data?.messages })
      .replace(/\s+/g, ' ').slice(0, 220)}`)
  }
}

const filtered = needle ? lines.filter((l) => l.includes(needle)) : lines
for (const line of (tail > 0 ? filtered.slice(-tail) : filtered)) console.log(line)
