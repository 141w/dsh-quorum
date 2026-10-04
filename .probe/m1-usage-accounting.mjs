// M1: what does the harness actually record in `TokenUsage`, and which formula
// is the billed one?
//
// The plugin claims (index.js:49-55, docs/architecture.md:60-64) that
// `totalTokens` double-counts `cacheRead` and therefore bills `input + output`.
// The installed runtime's own header says the opposite:
//
//   dsh-llm/lib/types/types.d.ts:153-158
//   "Counts are DISJOINT: `inputTokens` is uncached input only; cached input is
//    reported separately as `cacheReadTokens`/`cacheWriteTokens`
//    (billed input = sum of the three)."
//
// A header is not evidence about a real log. This script reads every committed
// session log under $DSH_HOME/sessions and measures the recorded usage, so the
// formula is decided by data rather than by either claim.
//
// Read-only: it decompresses with zstd and prints. It writes nothing.
//
//   node .probe/m1-usage-accounting.mjs
//
// Env: ZSTD (default: the miniconda build the other probes cite), DSH_HOME.

import { execFileSync } from 'node:child_process'
import { readdirSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const ZSTD = process.env.ZSTD ?? join(homedir(), 'miniconda3/bin/zstd')
const HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const SESSIONS = join(HOME, 'sessions')

/** Every `session.v4.jsonl.zstd` under the sessions root, two levels deep. */
function logFiles() {
  const found = []
  for (const workspace of readdirSync(SESSIONS)) {
    const dir = join(SESSIONS, workspace)
    if (!statSync(dir).isDirectory()) continue
    for (const session of readdirSync(dir)) {
      const file = join(dir, session, 'session.v4.jsonl.zstd')
      if (existsSync(file)) found.push({ session, file })
    }
  }
  return found
}

/** Decode one compressed log into events. The only place zstd is allowed. */
function readLog(file) {
  const text = execFileSync(ZSTD, ['-dc', file], { maxBuffer: 1 << 30 }).toString('utf8')
  const events = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      events.push(JSON.parse(line))
    } catch {
      // A trailing partial line is not an event; skip it rather than fail the run.
    }
  }
  return events
}

const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
const sum = (values) => values.reduce((a, b) => a + b, 0)
const fmt = (n) => n.toLocaleString('en-US')

const samples = []
const perSession = []

for (const { session, file } of logFiles()) {
  const events = readLog(file)
  const usages = events
    .filter((event) => event?.type === 'assistant/message' && event.data?.usage !== undefined)
    .map((event) => event.data.usage)
  if (usages.length === 0) continue

  const rows = usages.map((usage) => ({
    input: num(usage.inputTokens),
    output: num(usage.outputTokens),
    cacheRead: num(usage.cacheReadTokens),
    cacheWrite: num(usage.cacheWriteTokens),
    total: usage.totalTokens === undefined ? undefined : num(usage.totalTokens),
    hasPromptTokens: usage.prompt_tokens !== undefined,
    hasCompletionTokens: usage.completion_tokens !== undefined,
    raw: usage,
  }))
  samples.push(...rows)
  perSession.push({ session, calls: rows.length, rows })
}

if (samples.length === 0) {
  console.log('no assistant/message event carrying usage was found under', SESSIONS)
  process.exit(0)
}

const col = {
  input: sum(samples.map((r) => r.input)),
  output: sum(samples.map((r) => r.output)),
  cacheRead: sum(samples.map((r) => r.cacheRead)),
  cacheWrite: sum(samples.map((r) => r.cacheWrite)),
}

console.log('='.repeat(78))
console.log(`M1 usage accounting — ${perSession.length} session(s), ${samples.length} assistant/message call(s)`)
console.log('='.repeat(78))
console.log()
console.log('Field presence across samples:')
console.log(`  inputTokens          ${samples.length}/${samples.length}`)
console.log(`  outputTokens         ${samples.length}/${samples.length}`)
console.log(`  cacheReadTokens      ${samples.filter((r) => r.raw.cacheReadTokens !== undefined).length}/${samples.length}`)
console.log(`  cacheWriteTokens     ${samples.filter((r) => r.raw.cacheWriteTokens !== undefined).length}/${samples.length}`)
console.log(`  totalTokens          ${samples.filter((r) => r.total !== undefined).length}/${samples.length}`)
console.log(`  prompt_tokens        ${samples.filter((r) => r.hasPromptTokens).length}/${samples.length}`)
console.log(`  completion_tokens    ${samples.filter((r) => r.hasCompletionTokens).length}/${samples.length}`)
console.log()
console.log('Distinct field sets seen in real logs (one line per shape):')
const shapes = new Set(samples.map((r) => Object.keys(r.raw).sort().join(', ')))
for (const shape of shapes) console.log(`  { ${shape} }`)
console.log()
console.log('One raw sample, verbatim:')
console.log(' ', JSON.stringify(samples[0].raw))
console.log()

console.log('Column totals over every call:')
console.log(`  input (uncached)     ${fmt(col.input)}`)
console.log(`  output               ${fmt(col.output)}`)
console.log(`  cacheRead            ${fmt(col.cacheRead)}`)
console.log(`  cacheWrite           ${fmt(col.cacheWrite)}`)
console.log()

/** The candidate formulas under test. */
const formulas = [
  { name: 'A  billed = input + output            (plugin today)', value: col.input + col.output },
  { name: 'B  billed = input + cacheRead + cacheWrite + output  (dsh-llm header)', value: col.input + col.cacheRead + col.cacheWrite + col.output },
  { name: 'C  billed = input + cacheRead + output', value: col.input + col.cacheRead + col.output },
]
console.log('Candidate "billed" totals:')
for (const formula of formulas) {
  const ratio = formula.value === 0 ? 0 : (col.input + col.cacheRead + col.cacheWrite + col.output) / formula.value
  console.log(`  ${formula.name}`)
  console.log(`      ${fmt(formula.value)}   (B/A = ${ratio.toFixed(3)}x)`)
}
console.log()

// The decisive identity check: does totalTokens equal B on the samples that carry it?
const withTotal = samples.filter((r) => r.total !== undefined)
if (withTotal.length > 0) {
  const b = sum(withTotal.map((r) => r.input + r.cacheRead + r.cacheWrite + r.output))
  const t = sum(withTotal.map((r) => r.total))
  const a = sum(withTotal.map((r) => r.input + r.output))
  console.log(`Identity check on the ${withTotal.length} sample(s) carrying totalTokens:`)
  console.log(`  sum(totalTokens)                       ${fmt(t)}`)
  console.log(`  sum(B) = input+cacheRead+cacheWrite+out ${fmt(b)}   (delta vs totalTokens: ${fmt(b - t)})`)
  console.log(`  sum(A) = input+output                  ${fmt(a)}   (delta vs totalTokens: ${fmt(a - t)})`)
  console.log(`  => B ${b === t ? 'EXACTLY equals' : 'does NOT equal'} totalTokens on these samples; A is off by ${t === 0 ? 'n/a' : ((a - t) / t * 100).toFixed(1)}%`)
  console.log()
  console.log('  Per-sample, where the fields disagree (first 8):')
  for (const r of withTotal.slice(0, 8)) {
    console.log(`    in=${fmt(r.input)} out=${fmt(r.output)} cr=${fmt(r.cacheRead)} cw=${fmt(r.cacheWrite)} total=${fmt(r.total)} | B-total=${fmt(r.input + r.cacheRead + r.cacheWrite + r.output - r.total)}`)
  }
} else {
  console.log('No sample carries totalTokens, so the identity cannot be checked here.')
}
console.log()

console.log('Per-session billed totals (A = plugin today, B = disjoint sum):')
for (const s of perSession) {
  const a = sum(s.rows.map((r) => r.input + r.output))
  const b = sum(s.rows.map((r) => r.input + r.cacheRead + r.cacheWrite + r.output))
  console.log(`  ${s.session.padEnd(48)} calls=${String(s.calls).padStart(3)}  A=${fmt(a).padStart(10)}  B=${fmt(b).padStart(10)}  B/A=${(a === 0 ? 0 : b / a).toFixed(2)}x`)
}
