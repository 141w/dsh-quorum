/**
 * Repair the sessions this plugin bricked, by giving the injected message the identity
 * the session validator requires.
 *
 * What happened: `agent.inject()` was called without `id` and without `role`, so when the
 * injected item was admitted as its own `user/message` the durable log carried a message
 * with no identity — and `assertMessageEventShape` refuses to replay it (`lacks an
 * identified message`), which makes the conversation impossible to open again. Fixed in
 * code for 0.3.2 (`index.js`); this file deals with the damage already written.
 *
 * What changes, and nothing else: a `user/message` payload with no usable `id` gains
 * `id` (fresh UUID) and `role: "user"`, appended after the existing keys so the repaired
 * line is shaped exactly like the healthy ones (`content, source, role, id`).
 * `source.kind` is left alone: the validator only wants a non-empty string there,
 * `system` is what the model was actually shown, and rewriting it would be editing
 * history rather than repairing a key.
 *
 * On-disk shape is load-bearing and this tool learned that the hard way. A session log is
 * a concatenation of zstd frames — the first holding exactly one line, the `session`
 * header — and one further frame per append batch. The first draft decompressed the whole
 * file, patched it and recompressed it as a single frame; the runtime then answered
 * `corrupt Zstandard session log: first frame is not exactly one header line`, i.e. it
 * replaced a late validation error with an earlier one and made things worse. So this
 * version only rebuilds the frames whose text actually changed, and copies every other
 * frame byte-for-byte, which keeps the header frame untouched by construction.
 *
 * Guards: dry-run unless `--apply`; each touched file is copied to a backup directory
 * first; a written file is re-read through the same decode path the app uses and rolled
 * back if anything still fails validation.
 *
 * Usage:
 *   node .probe/repair-bricked-sessions.mjs                     # report only
 *   node .probe/repair-bricked-sessions.mjs --apply
 *   node .probe/repair-bricked-sessions.mjs --apply --only session-ab12
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'

// `node:zlib` exposes `ZstdCompress`/`ZstdDecompress` as stream classes in Node 22, not
// as one-shot functions, and calling them like functions throws — which this tool's own
// guard then reads as "frames do not verify" and refuses every file. The CLI is the
// boring reliable route, and the same binary is what the runtime ships against.
const ZSTD = join(homedir(), 'miniconda3/bin/zstd')

const APPLY = process.argv.includes('--apply')
const onlyAt = process.argv.indexOf('--only')
const ONLY = onlyAt === -1 ? null : process.argv[onlyAt + 1]
const SESSIONS_DIR = join(homedir(), '.dsh/sessions')
const BACKUPS = join(homedir(), '.dsh/backups/bricked-sessions-2026-10-08')
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

const zstdUnpack = (bytes) => execFileSync(ZSTD, ['-dc'], { input: bytes, maxBuffer: 1 << 28 }).toString('utf8')
const zstdPack = (text) => execFileSync(ZSTD, ['-c'], { input: Buffer.from(text, 'utf8'), maxBuffer: 1 << 28 })

/** `user/message` payloads are flat; the others nest the message under `data.message`. */
const ROLE_BY_TYPE = {
  'user/message': 'user',
  'assistant/message': 'assistant',
  'system/message': 'system',
  'developer/message': 'developer',
}

/** @returns a reason string when the runtime would refuse to replay this event. */
function validate(event) {
  const type = event?.type
  if (!(type in ROLE_BY_TYPE)) return null
  const data = event?.data
  if (data === null || typeof data !== 'object') return null
  const message = type === 'user/message' ? data : data.message
  if (message === null || typeof message !== 'object') return `${type} lacks an identified message`
  if (typeof message.id !== 'string' || message.id === '') return `${type} lacks an identified message`
  if (message.role !== ROLE_BY_TYPE[type]) return `${type} message must have role "${ROLE_BY_TYPE[type]}"`
  const source = message.source
  if (source === null || typeof source !== 'object' || typeof source.kind !== 'string' || source.kind === '') return `${type} message has invalid source`
  if (!Array.isArray(message.content)) return `${type} message has invalid content`
  return null
}

/** @returns the line with an identity defect, i.e. the one this tool exists to fix. */
function identityDefect(line) {
  let event
  try { event = JSON.parse(line) } catch { return null }
  if (event?.type !== 'user/message') return null
  return validate(event) === 'user/message lacks an identified message' ? event : null
}

function repairLine(line) {
  const event = JSON.parse(line)
  return JSON.stringify({ ...event, data: { ...event.data, role: 'user', id: randomUUID() } })
}

/**
 * Frame ranges plus their decoded text. The magic bytes can also occur inside compressed
 * data, so a candidate split is only accepted when every slice decodes on its own and
 * ends on a line boundary of complete JSON lines — otherwise the caller refuses the file.
 */
function readFrames(bytes) {
  const starts = []
  for (let at = bytes.indexOf(MAGIC); at >= 0; at = bytes.indexOf(MAGIC, at + 1)) starts.push(at)
  if (!starts.length) return null
  const ranges = starts.map((from, index) => ({ from, to: index + 1 < starts.length ? starts[index + 1] : bytes.length }))
  const lines = []
  for (const range of ranges) {
    let text
    try {
      text = zstdUnpack(bytes.subarray(range.from, range.to))
    } catch {
      return null
    }
    if (!text.endsWith('\n')) return null
    const frameLines = text.split('\n').slice(0, -1)
    if (frameLines.some((line) => line === '')) return null
    try {
      frameLines.forEach((line) => JSON.parse(line))
    } catch {
      return null
    }
    lines.push(frameLines)
  }
  return { ranges, lines }
}

const targets = []
for (const workspace of readdirSync(SESSIONS_DIR)) {
  const wsDir = join(SESSIONS_DIR, workspace)
  if (!statSync(wsDir).isDirectory()) continue
  for (const name of readdirSync(wsDir)) {
    if (ONLY !== null && !name.startsWith(ONLY)) continue
    const file = join(wsDir, name, 'session.v4.jsonl.zstd')
    if (existsSync(file)) targets.push({ name, workspace, file })
  }
}

if (APPLY) mkdirSync(BACKUPS, { recursive: true })

let sessionsTouched = 0
let eventsPatched = 0
const failures = []

for (const { name, workspace, file } of targets) {
  const bytes = readFileSync(file)
  const frames = readFrames(bytes)
  if (frames === null) {
    failures.push(`${name}: frame boundaries did not verify — refused, nothing written`)
    continue
  }
  if (frames.lines[0].length !== 1 || !frames.lines[0][0].includes('"type":"session"')) {
    failures.push(`${name}: first frame is not the single header line — refused, nothing written`)
    continue
  }

  const rebuilt = []
  let filePatched = 0
  let refused = false
  for (const [index, frameLines] of frames.lines.entries()) {
    const range = frames.ranges[index]
    const patched = frameLines.map((line) => {
      if (identityDefect(line) === null) return line
      const next = repairLine(line)
      if (validate(JSON.parse(next)) !== null) {
        refused = true
        return line
      }
      filePatched += 1
      return next
    })
    // Untouched frames are copied as bytes: same compressed content, same boundaries,
    // so the append history keeps its exact shape.
    rebuilt.push(patched.every((line, at) => line === frameLines[at])
      ? bytes.subarray(range.from, range.to)
      : zstdPack(`${patched.join('\n')}\n`))
  }

  if (refused) {
    failures.push(`${name}: a repaired line still failed validation — refused, nothing written`)
    continue
  }
  if (filePatched === 0) continue

  sessionsTouched += 1
  eventsPatched += filePatched
  const label = `${name}  (${workspace})`
  if (!APPLY) {
    console.log(`would repair ${filePatched} event(s): ${label}`)
    continue
  }

  const backup = join(BACKUPS, `${name}.zstd.orig`)
  copyFileSync(file, backup)
  writeFileSync(file, Buffer.concat(rebuilt))

  // Read it back the way the app will, and put the original bytes back on any doubt.
  try {
    const after = zstdUnpack(readFileSync(file)).split('\n').filter(Boolean).map((line) => JSON.parse(line))
    const remaining = after.filter((event) => validate(event) !== null)
    const lost = after.length !== readFrames(readFileSync(backup))?.lines.flat().length
    if (remaining.length > 0 || lost) {
      copyFileSync(backup, file)
      failures.push(`${name}: rolled back (${remaining.length} invalid, line count preserved: ${!lost})`)
      continue
    }
    console.log(`repaired ${filePatched} event(s); backup ${backup}; ${label}`)
  } catch (error) {
    copyFileSync(backup, file)
    failures.push(`${name}: rolled back after a failed re-read (${error.message})`)
  }
}

console.log(`\n${APPLY ? 'applied' : 'dry run'}: ${sessionsTouched} session(s), ${eventsPatched} event(s)`)
if (failures.length) {
  console.log('failures:')
  for (const failure of failures) console.log(`  ${failure}`)
  process.exitCode = 1
}
