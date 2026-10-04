// D6: decide, from durable evidence, whether the cost tiers actually fired.
//
// The cost discipline is the one layer with no live evidence. Every other claim in
// this bundle was verified on a real run and the raw output kept; the budget has
// only ever been exercised by unit tests, because under the old billing formula
// (`input + output`, low by 96.9%) the threshold was effectively out of reach.
// 0.2.0 fixes the formula and recalibrates the default, which makes the live test
// possible for the first time.
//
// This script exists so the result is a judgement over the session log rather
// than the assistant's own account of itself:
//
//   1. find the team (Lead session id, or scan every session for `team/member`)
//   2. reconstruct the billed total from every member session's `assistant/message`
//      usage, using the shipped formula
//   3. read the Lead's and every member's log for the two denial strings the guard
//      produces, and for the plugin's own tier log line
//   4. report which tiers were crossed, and — the part that matters — whether a
//      crossed tier produced a denial, or crossed silently
//
// A tier that is crossed with no denial anywhere is a FAIL: it means the budget
// stopped enforcing while the plugin still looked installed. That is exactly the
// class of bug this whole project is about.
//
// Read-only: decompresses with zstd and prints. Writes nothing.
//
//   node .probe/cost-tier-check.mjs                          # every team it can find
//   node .probe/cost-tier-check.mjs --lead session-<uuid>    # one team
//   node .probe/cost-tier-check.mjs --budget 2000000         # override the default
//
// Env: ZSTD (default: the miniconda build the other probes cite), DSH_HOME.

import { execFileSync } from 'node:child_process'
import { readdirSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const ZSTD = process.env.ZSTD ?? join(homedir(), 'miniconda3/bin/zstd')
const HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const SESSIONS = join(HOME, 'sessions')

const argv = process.argv.slice(2)
const argValue = (flag, fallback) => {
  const at = argv.indexOf(flag)
  return at === -1 || argv[at + 1] === undefined ? fallback : argv[at + 1]
}
const ONLY_LEAD = argValue('--lead', undefined)
const BUDGET = Number(argValue('--budget', '2000000'))
const SOFT = BUDGET * 0.7
const HARD = BUDGET * 0.9

/** The shipped formula. Kept in sync by hand on purpose: this file must not
    import the plugin, because it is measuring what the plugin recorded, not what
    the plugin would compute today. */
const billed = (usage) =>
  (Number(usage?.inputTokens) || 0)
  + (Number(usage?.outputTokens) || 0)
  + (Number(usage?.cacheReadTokens) || 0)
  + (Number(usage?.cacheWriteTokens) || 0)

const fmt = (n) => Math.round(n).toLocaleString('en-US')
const text = (value) => (typeof value === 'string' ? value : JSON.stringify(value ?? ''))

function logFiles() {
  const found = []
  for (const workspace of readdirSync(SESSIONS)) {
    const dir = join(SESSIONS, workspace)
    if (!statSync(dir).isDirectory()) continue
    for (const session of readdirSync(dir)) {
      const file = join(dir, session, 'session.v4.jsonl.zstd')
      if (existsSync(file)) found.push({ session, workspace, file })
    }
  }
  return found
}

function readLog(file) {
  const raw = execFileSync(ZSTD, ['-dc', file], { maxBuffer: 1 << 30 }).toString('utf8')
  const events = []
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    try {
      events.push(JSON.parse(line))
    } catch {
      // trailing partial line
    }
  }
  return events
}

/** All logs, decoded once. Teams are cross-referenced, so a single pass is cheaper
    and keeps every session's events available for the denial scan. */
const logs = new Map()
for (const { session, workspace, file } of logFiles()) {
  logs.set(session, { session, workspace, file, events: readLog(file) })
}

/** Lead -> members, read from the Lead's own durable roster rows. */
function teamOf(leadId) {
  const lead = logs.get(leadId)
  if (!lead) return undefined
  const members = []
  for (const event of lead.events) {
    if (event?.type !== 'team/member') continue
    const id = event.data?.member?.id ?? event.data?.sessionId ?? event.data?.id
    if (typeof id === 'string') members.push(id)
  }
  return { leadId, members: [...new Set(members)] }
}

/** Sessions that look like Leads: they carry at least one team/member row. */
function findTeams() {
  const teams = []
  for (const entry of logs.values()) {
    if (!entry.events.some((event) => event?.type === 'team/member')) continue
    teams.push(teamOf(entry.session))
  }
  return teams.filter(Boolean)
}

/** Billed total and the running series, so a tier crossing can be located in time. */
function spend(ids) {
  const rows = []
  for (const id of ids) {
    const entry = logs.get(id)
    if (!entry) continue
    for (const event of entry.events) {
      if (event?.type !== 'assistant/message' || event.data?.usage === undefined) continue
      rows.push({ session: id, seq: event.seq, turn: event.data.turn, amount: billed(event.data.usage) })
    }
  }
  rows.sort((a, b) => a.seq - b.seq)
  let running = 0
  for (const row of rows) {
    running += row.amount
    row.running = running
  }
  return { rows, total: running }
}

/** The strings the guard returns, plus the plugin's own tier log line. */
const TIER_MARKERS = [
  { tier: 'soft', pattern: /cost budget reached \d+% of [\d,]+ billed tokens/ },
  { tier: 'hard', pattern: /report-only mode/ },
  { tier: 'log-soft', pattern: /quorum: team reached \d+% of its billed-token budget/ },
]

function findDenials(ids) {
  const hits = []
  for (const id of ids) {
    const entry = logs.get(id)
    if (!entry) continue
    const byCall = new Map()
    for (const event of entry.events) {
      if (event?.type === 'tool/call' && event.data?.callId !== undefined) {
        byCall.set(event.data.callId, event.data.name)
      }
    }
    for (const event of entry.events) {
      if (event?.type !== 'tool/result') continue
      const content = text(event.data?.message?.content)
      for (const marker of TIER_MARKERS) {
        if (marker.pattern.test(content)) {
          hits.push({
            session: id,
            seq: event.seq,
            tier: marker.tier,
            tool: byCall.get(event.data?.message?.toolCallId) ?? 'unknown',
            isError: event.data?.message?.isError === true,
            text: content.slice(0, 240),
          })
        }
      }
    }
  }
  return hits
}

const teams = ONLY_LEAD === undefined ? findTeams() : [teamOf(ONLY_LEAD)].filter(Boolean)

console.log('='.repeat(78))
console.log('D6 cost-tier live check')
console.log('='.repeat(78))
console.log(`budget: max=${fmt(BUDGET)}  soft(0.7)=${fmt(SOFT)}  hard(0.9)=${fmt(HARD)}`)
console.log(`sessions decoded: ${logs.size}   teams found: ${teams.length}`)
console.log()

if (teams.length === 0) {
  console.log('No team found in these logs.')
  console.log()
  console.log('If you have just run the scenario, check that the sessions are under')
  console.log(`  ${SESSIONS}`)
  console.log('and that the Lead is the session which owns the team/member rows.')
  process.exit(0)
}

let silent = 0
for (const team of teams) {
  const ids = [team.leadId, ...team.members]
  const { rows, total } = spend(ids)
  const crossedSoft = total >= SOFT
  const crossedHard = total >= HARD
  const denials = findDenials(ids)

  console.log('-'.repeat(78))
  console.log(`team lead: ${team.leadId}`)
  console.log(`  members (${team.members.length}): ${team.members.join(', ') || 'none'}`)
  console.log(`  assistant messages with usage: ${rows.length}`)
  // Per-session composition, so the total is attributed rather than asserted. The
  // roster only lists strict members; a sibling session in the same workspace that
  // ran concurrently but was never spawned into this team must not be counted, and
  // this listing is what makes that visible.
  for (const id of ids) {
    const own = rows.filter((row) => row.session === id)
    if (own.length === 0) continue
    const role = id === team.leadId ? 'lead  ' : 'member'
    console.log(`    ${role} ${id}  calls=${String(own.length).padStart(3)}  billed=${fmt(own.reduce((sum, row) => sum + row.amount, 0))}`)
  }
  console.log(`  billed total: ${fmt(total)}  (${((total / BUDGET) * 100).toFixed(1)}% of budget)`)
  console.log(`  crossed soft: ${crossedSoft ? 'YES' : 'no'}    crossed hard: ${crossedHard ? 'YES' : 'no'}`)

  // Where the crossing happened, so the reader can open that turn.
  for (const [label, threshold, flag] of [['soft', SOFT, crossedSoft], ['hard', HARD, crossedHard]]) {
    if (!flag) continue
    const first = rows.find((row) => row.running >= threshold)
    if (first) {
      console.log(`  ${label} first reached at seq ${first.seq} (turn ${first.turn ?? '?'}) in ${first.session}`)
    }
  }

  // Who was still spending after the crossing — a crossed tier that did not stop
  // anything is the interesting failure.
  const afterSoft = crossedSoft ? rows.filter((row) => row.running > SOFT).length : 0
  console.log(`  messages billed after the soft threshold: ${afterSoft}`)

  if (denials.length === 0) {
    console.log('  denials: none recorded')
  } else {
    console.log(`  denials: ${denials.length}`)
    for (const hit of denials.slice(0, 8)) {
      console.log(`    [${hit.tier}] seq ${hit.seq} tool=${hit.tool} isError=${hit.isError} session=${hit.session}`)
      console.log(`      ${hit.text.replace(/\s+/g, ' ')}`)
    }
  }

  console.log()
  if (!crossedSoft && !crossedHard) {
    console.log('  VERDICT: no tier was reached — this round is not evidence either way.')
    console.log('           Run a round that bills past the soft threshold (see docs/D6-cost-tier-live.md).')
  } else if (denials.length > 0) {
    console.log('  VERDICT: PASS — a tier was crossed and the guard recorded a denial.')
  } else {
    silent += 1
    console.log('  VERDICT: FAIL — a tier was crossed and NOTHING was denied.')
    console.log('           The budget stopped enforcing while the plugin still looked installed.')
  }
  console.log()
}

console.log('='.repeat(78))
console.log(silent === 0
  ? 'no silent tier crossing found'
  : `${silent} team(s) crossed a tier silently — that is the defect this check exists for`)
process.exit(silent === 0 ? 0 : 1)
