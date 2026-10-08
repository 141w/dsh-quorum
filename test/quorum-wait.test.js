import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, judgeQuorum, waitForQuorum } from '../index.js'
import { fakeSession, memberLog, report } from './fixtures/member-log.js'
import { makeEffect } from './fixtures/host-ctx.js'

// Fixtures use the shapes read off the installed runtime, not invented ones:
// TeamMemberView (dsh-experimental-agent-team lib/types/types.d.ts:42-52) and the
// two persisted mailbox event payloads (lib/invariant.js:236-246).
const CONFIG = {
  roles: {
    lead: { shape: 'ship', writeScopes: [], maxMembers: 4 },
    reviewer: { shape: 'scout', allow: ['read', 'grep'] },
  },
  defaultRole: { shape: 'scout', allow: ['read'] },
  budget: { maxBilledTokens: 400000, softTier: 0.7, hardTier: 0.9 },
  quorum: { requires: 'all', timeoutMs: 300000, pollMs: 30000 },
}

const LEAD = 'session-a86ccf90'
const REVIEWER = '5a8357c3'
const FIXER = 'bd9211e9'

const row = (name, id, status, role = 'teammate') => ({ name, id, role, status, diagnostics: [] })

const msg = (id, senderId, senderName, targetId) => ({
  id,
  senderId,
  senderName,
  targetId,
  content: [{ type: 'text', text: `${senderName}: verdict` }],
})

// Folding the event stream the way upstream's projection does (invariant.js:370-386)
// keeps every case writable as the log it imitates: queued minus delivered is unread.
function fold(events) {
  const messages = []
  const delivered = []
  for (const event of events) {
    if (event.type === 'team/message/queued') messages.push(event.data.message)
    else delivered.push(event.data.messageId)
  }
  return { messages, delivered }
}

const queued = (message) => ({ type: 'team/message/queued', data: { version: 2, teamId: LEAD, message } })
const delivered = (message) => ({
  type: 'team/message/delivered',
  data: { version: 2, teamId: LEAD, messageId: message.id, targetId: message.targetId },
})

// `tools.register` enforces output.schema against every returned value at runtime,
// so a drifted key would only surface as a ToolOutputError inside a live turn.
function assertMatchesSchema(value, schema, path = 'value') {
  if (schema.type === 'array') {
    value.forEach((item, index) => assertMatchesSchema(item, schema.items, `${path}[${index}]`))
    return
  }
  for (const key of schema.required ?? []) assert.ok(value[key] !== undefined, `${path}.${key} is required`)
  for (const key of Object.keys(value)) assert.ok(schema.properties?.[key], `${path}.${key} is not declared`)
}

// These cases pin the mailbox and wait behaviour, so evidence is asserted away.
// Whether a report *earns* that status is pinned in evidence-gate.test.js, and
// judgeQuorum refuses to run at all without a resolver.
const ASSUME_VERIFIED = () => ({ status: 'verified', detail: 'evidence assumed by fixture' })

test('every teammate delivered -> quorum met on the first read, without waiting', async () => {
  const a = msg('m1', REVIEWER, 'reviewer', LEAD)
  const b = msg('m2', FIXER, 'fixer', LEAD)
  const state = fold([queued(a), delivered(a), queued(b), delivered(b)])
  let waits = 0
  const verdict = await waitForQuorum({
    timeoutMs: 300000,
    pollMs: 30000,
    now: () => 1000,
    read: () => ({
      roster: [row('lead', LEAD, 'running', 'lead'), row('reviewer', REVIEWER, 'running'), row('fixer', FIXER, 'running')],
      leadId: LEAD,
      requires: 'all',
      evidence: ASSUME_VERIFIED,
      ...state,
    }),
    wait: () => {
      waits += 1
      return Promise.resolve()
    },
  })

  assert.equal(verdict.quorumMet, true)
  assert.equal(verdict.timedOut, false)
  assert.equal(waits, 0, 'a converged mailbox must not block at all')
  assert.equal(verdict.required, 2)
  assert.equal(verdict.deliveredCount, 2)
  assert.equal(verdict.verifiedCount, 2)
  assert.deepEqual(verdict.members.map((m) => m.name), ['reviewer', 'fixer'])
  assert.equal(verdict.stalled, undefined)
})

test('a queued-but-undelivered submission counts as outstanding, not as a report', () => {
  const a = msg('m1', REVIEWER, 'reviewer', LEAD)
  const b = msg('m2', FIXER, 'fixer', LEAD)
  const verdict = judgeQuorum({
    roster: [row('lead', LEAD, 'running', 'lead'), row('reviewer', REVIEWER, 'running'), row('fixer', FIXER, 'running')],
    leadId: LEAD,
    requires: 'all',
    evidence: ASSUME_VERIFIED,
    ...fold([queued(a), delivered(a), queued(b)]),
  })

  assert.equal(verdict.quorumMet, false)
  assert.equal(verdict.deliveredCount, 1)
  assert.deepEqual(verdict.members.find((m) => m.name === 'fixer'), {
    name: 'fixer',
    status: 'running',
    submitted: false,
    inFlight: true,
    evidence: 'not-reported',
    evidenceDetail: '',
  })
  assert.equal(verdict.stalled, undefined, 'fixer is still running, so waiting can still pay off')
})

test('an inactive teammate is reported as inactive, never as a failure, and ends the wait', async () => {
  const a = msg('m1', REVIEWER, 'reviewer', LEAD)
  const state = fold([queued(a), delivered(a)])
  let waits = 0
  const verdict = await waitForQuorum({
    timeoutMs: 300000,
    pollMs: 30000,
    now: () => 1000,
    read: () => ({
      roster: [row('lead', LEAD, 'running', 'lead'), row('reviewer', REVIEWER, 'running'), row('fixer', FIXER, 'inactive')],
      leadId: LEAD,
      requires: 'all',
      evidence: ASSUME_VERIFIED,
      ...state,
    }),
    wait: () => {
      waits += 1
      return Promise.resolve()
    },
  })

  assert.equal(verdict.members.find((m) => m.name === 'fixer').status, 'inactive')
  assert.equal(verdict.quorumMet, false)
  assert.equal(verdict.timedOut, false, 'nothing can arrive on its own, so the deadline is not the reason for stopping')
  assert.equal(waits, 0, 'a member that is not running must not be waited on until the deadline')
  assert.equal(verdict.stalled.reason, 'no-active-member')
})

test('a running member who never reports ends in a timeout verdict, not an error', async () => {
  const chunks = []
  const reads = []
  let clock = 1000
  const verdict = await waitForQuorum({
    timeoutMs: 70000,
    pollMs: 30000,
    now: () => clock,
    read: () => {
      reads.push(clock)
      return {
        roster: [row('lead', LEAD, 'running', 'lead'), row('reviewer', REVIEWER, 'running')],
        leadId: LEAD,
        requires: 'all',
        evidence: ASSUME_VERIFIED,
        messages: [],
        delivered: [],
      }
    },
    wait: (ms) => {
      chunks.push(ms)
      clock += ms
      return Promise.resolve()
    },
  })

  assert.equal(verdict.quorumMet, false)
  assert.equal(verdict.timedOut, true)
  assert.equal(verdict.stalled, undefined)
  // The last sliver is the remaining budget, not a whole poll interval, and the
  // deadline is only sampled once a wait has settled, so it lands exactly on it.
  assert.deepEqual(chunks, [30000, 30000, 10000])
  assert.deepEqual(reads, [1000, 31000, 61000, 71000])
  assert.equal(verdict.waitedMs, 70000)
})

test('caller cancellation travels through the wait instead of being swallowed', async () => {
  const abort = new Error('aborted by harness')
  await assert.rejects(
    waitForQuorum({
      timeoutMs: 60000,
      pollMs: 30000,
      now: () => 1000,
      read: () => ({
        roster: [row('lead', LEAD, 'running', 'lead'), row('reviewer', REVIEWER, 'running')],
        leadId: LEAD,
        requires: 'all',
        evidence: ASSUME_VERIFIED,
        messages: [],
        delivered: [],
      }),
      wait: () => Promise.reject(abort),
    }),
    /aborted by harness/,
  )
})

test('the Lead gains quorum_wait exactly once, a teammate gains nothing, and the call forwards exec.signal', async () => {
  const a = msg('m1', REVIEWER, 'reviewer', LEAD)
  const registrations = []
  const waits = []
  const listeners = new Map()
  const evidenceReads = []
  let reads = 0

  const lead = { id: LEAD, subagent: false, session: { id: LEAD, cwd: '/work' } }
  const reviewer = { id: REVIEWER, parentId: LEAD, parentAgent: lead, subagent: false, session: { id: REVIEWER, cwd: '/work' } }
  for (const self of [lead, reviewer]) {
    self.ctx = {
      // `apply()` arms a role card inside two nested effects, so the stub must
      // answer `effect`; see fixtures/host-ctx.js for why omitting it is a lie.
      effect: makeEffect([], `agent(${self.id})`).effect,
      tools: { guard() {}, register(tool) { registrations.push({ agent: self, tool }) } },
      systemPrompt: { section() {} },
    }
  }

  const ctx = {
    logger: { info() {}, warn() {} },
    // Keyed by event type, because the runtime dispatches per type: a flat list
    // would feed the `agent/disposed` and `session/disposed` listeners an
    // `agent/created` payload and tear down the very registration this case counts.
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, [])
      listeners.get(type).push(fn)
    },
    effect: makeEffect([], 'ctx').effect,
    agentTeams: {
      tryMembership: (agent) => (agent === reviewer
        ? { root: lead, id: LEAD, role: 'teammate', name: 'reviewer' }
        : { root: agent, id: agent.id, role: 'lead', name: 'lead' }),
      listMembers: () => [
        row('lead', LEAD, 'running', 'lead'),
        ...(reviewer.rostered ? [row('reviewer', REVIEWER, 'running')] : []),
      ],
      waitForChange: (_agent, ms, signal) => {
        waits.push({ ms, signal })
        return Promise.resolve({ timedOut: true })
      },
    },
    sessionProjections: {
      // The first cut is before the submission lands; the second one has it.
      stateOf: (_session, key) => {
        if (key !== 'agentTeam') return undefined
        reads += 1
        return reads === 1 ? { messages: [], delivered: [] } : { messages: [a], delivered: [a.id] }
      },
    },
    sessions: {
      // The honest path: the member ran a tool, then reported. Reaching quorum
      // through this fixture is the reachability proof; see evidence-gate.test.js
      // for the same roster with the tool execution missing.
      get: (id) => {
        evidenceReads.push(id)
        return id === REVIEWER
          ? fakeSession(REVIEWER, memberLog([{ name: 'read', text: 'def add(a, b):\n    return a + b' }, report(a.id)]))
          : undefined
      },
    },
  }

  apply(ctx, CONFIG)
  const emit = (agent) => {
    const original = console.log
    console.log = () => {}
    try {
      for (const fn of listeners.get('agent/created') ?? []) fn({ agent })
    } finally {
      console.log = original
    }
  }

  emit(lead)
  assert.equal(registrations.length, 0, 'a team of one must not gain the tool')
  reviewer.rostered = true
  emit(reviewer)

  assert.deepEqual(registrations.map((r) => [r.agent === lead, r.tool.name]), [[true, 'quorum_wait']])

  const tool = registrations[0].tool
  const controller = new AbortController()
  const value = await tool.execute({ timeout_ms: 60000 }, { agent: lead, signal: controller.signal })

  assert.equal(value.quorumMet, true)
  assert.equal(value.verifiedCount, 1)
  assert.equal(value.deliveredCount, 1)
  assert.deepEqual(evidenceReads, [REVIEWER], 'the gate must read the member session, not assume')
  assert.equal(value.members[0].evidence, 'verified')
  assert.match(value.members[0].evidenceDetail, /read at seq 4/)
  assert.ok(value.waitedMs < 60000, `waited ${value.waitedMs}ms for an instantly-resolved wake`)
  assertMatchesSchema(value, tool.output.schema)
  assert.equal(waits.length, 1)
  assert.equal(waits[0].signal, controller.signal, 'the wait must be cancellable by the caller')
  assert.ok(waits[0].ms >= 10000 && waits[0].ms <= 30000, `poll chunk out of range: ${waits[0].ms}`)

  const [block] = tool.output.render({}, value)
  assert.match(block.text, /Quorum met/)
  assert.match(block.text, /1\/1/)
  assert.match(block.text, /reviewer \[running\] reported\+verified/)
  assert.match(block.text, /reported\+verified — 1 successful tool result\(s\) before it reported; earliest: read at seq 4/)
})
