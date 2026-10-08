/**
 * Scan every stored session for events the runtime's own validator would refuse:
 * a message-bearing event whose message has no usable `id`.
 *
 * Why this exists: `agent.inject()` takes a `UserMessage` and performs no validation
 * at the boundary, so a plugin that omits `id` writes a `user/message` the reload
 * validator rejects with `lacks an identified message` (dsh-session/lib/index.js:1197)
 * — and the conversation is then unopenable forever. That happened on our side for
 * three released versions (docs/verification.md D15), and the only way to size the
 * damage is to read the logs rather than guess from the code path.
 *
 * Read-only: it decompresses and parses, never writes to a session directory.
 *
 * Usage: node .probe/scan-corrupt-sessions.mjs [needle]
 *   needle - optional substring; reports which offenders also carry it.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const needle = process.argv[2] ?? null
const ZSTD = join(homedir(), 'miniconda3/bin/zstd')
const root = join(homedir(), '.dsh/sessions')
// `assertMessageEventShape` (dsh-session/lib/index.js:1190-1215), transcribed rather
// than paraphrased, because the `user/message` payload is FLAT — the record itself is
// the message — while every other message type nests it under `data.message`. Getting
// that backwards reports 48 healthy sessions as broken, which is what the first draft
// of this file did.
const ROLE_BY_TYPE = {
  'system/message': 'system',
  'developer/message': 'developer',
  'user/message': 'user',
  'assistant/message': 'assistant',
  'tool/result': 'tool',
}

/** @returns a reason string when the runtime would refuse to reopen this event. */
function validate(event) {
  const type = event?.type
  if (!(type in ROLE_BY_TYPE)) return null
  const data = event?.data
  if (data === null || typeof data !== 'object') return `${type} has no payload`
  const message = type === 'user/message' ? data : data.message
  if (message === null || typeof message !== 'object') return `${type} lacks an identified message`
  if (typeof message.id !== 'string' || message.id === '') return `${type} lacks an identified message`
  if (message.role !== ROLE_BY_TYPE[type]) return `${type} message must have role "${ROLE_BY_TYPE[type]}"`
  const source = message.source
  if (source === null || typeof source !== 'object' || typeof source.kind !== 'string' || source.kind === '') return `${type} message has invalid source`
  if (!Array.isArray(message.content)) return `${type} message has invalid content`
  if (type === 'system/message' && source.kind !== 'system-prompt') return `${type} message must have system-prompt source`
  if (type === 'assistant/message' && source.kind !== 'model') return `${type} message must have model source`
  if (type === 'tool/result') {
    if (source.kind !== 'tool' || typeof source.callId !== 'string' || source.callId === '') return `${type} message must have tool source`
    if (message.toolCallId !== source.callId) return `${type} message has mismatched tool call ids`
  }
  return null
}

const decode = (file) => {
  try {
    return execFileSync(ZSTD, ['-dc', file], { maxBuffer: 1 << 28 }).toString()
  } catch {
    return ''
  }
}

const rows = []
for (const workspace of readdirSync(root)) {
  const wsDir = join(root, workspace)
  if (!existsSync(wsDir)) continue
  for (const session of readdirSync(wsDir)) {
    const file = join(wsDir, session, 'session.v4.jsonl.zstd')
    if (!existsSync(file)) continue
    let events = []
    try {
      events = decode(file).split('\n').filter(Boolean).map((line) => JSON.parse(line))
    } catch {
      rows.push({ session, workspace, error: 'unreadable' })
      continue
    }
    const offenders = []
    let carriesNeedle = false
    for (const event of events) {
      const reason = validate(event)
      if (reason !== null) {
        offenders.push({ seq: event.seq, type: event.type, reason, keys: Object.keys(event.data ?? {}).join(',') })
      }
    }
    if (needle) {
      for (const event of events) {
        const text = JSON.stringify(event?.data ?? {})
        if (text.includes(needle)) {
          carriesNeedle = true
          break
        }
      }
    }
    if (offenders.length) rows.push({ session, workspace, offenders, carriesNeedle })
  }
}

const bad = rows.filter((row) => row.offenders)
console.log(`sessions scanned: ${readdirSync(root).reduce((n, ws) => n + readdirSync(join(root, ws)).length, 0)}`)
console.log(`rejected-on-reload shape found in: ${bad.length} session(s)`)
if (needle) console.log(`of those, carrying ${JSON.stringify(needle)}: ${bad.filter((row) => row.carriesNeedle).length}`)
for (const row of bad) {
  console.log(`\n${row.session}  (${row.workspace.slice(0, 46)}…)`)
  for (const offender of row.offenders.slice(0, 4)) {
    console.log(`  seq ${offender.seq}  ${offender.type}  →  ${offender.reason}  keys=${offender.keys}`)
  }
}
