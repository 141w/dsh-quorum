import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, judgeQuorum, judgeEvidence } from '../index.js'
import { fakeSession, memberLog, report } from './fixtures/member-log.js'

// A report that no tool execution backs is exactly the failure this whole layer
// exists to catch: the earlier "model self-reports confidence" design, moved from
// the prompt into the mailbox. These cases pin that a delivered message alone
// never meets the quorum, and that a member which *did* the work still can.
const CONFIG = {
  roles: {
    lead: { shape: 'ship', writeScopes: [], maxMembers: 4 },
    reviewer: { shape: 'scout', allow: ['read', 'grep'] },
  },
  defaultRole: { shape: 'scout', allow: ['read'] },
  budget: { maxBilledTokens: 400000, softTier: 0.7, hardTier: 0.9 },
  quorum: { requires: 1, timeoutMs: 60000, pollMs: 30000 },
}

const LEAD = 'session-a86ccf90'
const REVIEWER = '5a8357c3'
const MESSAGE = 'team-message-f7d82a68'

const row = (name, id, status, role = 'teammate') => ({ name, id, role, status, diagnostics: [] })
const submission = { id: MESSAGE, senderId: REVIEWER, senderName: 'reviewer', targetId: LEAD, content: [] }

// The honest log: `read` succeeds, then `send_message` whose result carries the
// very id the Lead's mailbox shows as delivered.
const HONEST = memberLog([{ name: 'read', text: 'def add(a, b):\n    return a + b' }, report(MESSAGE)])

/**
 * Drive one full `quorum_wait` call against a team whose single teammate has
 * delivered `MESSAGE`, with the member's own log supplied by `own`.
 */
async function askLead(own, opts = {}) {
  const registrations = []
  const listeners = []
  const lead = { id: LEAD, subagent: false, session: { id: LEAD, cwd: '/work' } }
  const reviewer = { id: REVIEWER, parentId: LEAD, parentAgent: lead, subagent: false, session: { id: REVIEWER, cwd: '/work' } }
  for (const self of [lead, reviewer]) {
    self.ctx = {
      tools: { guard() {}, register(tool) { registrations.push({ agent: self, tool }) } },
      systemPrompt: { section() {} },
    }
  }

  let lookups = 0
  const ctx = {
    logger: { info() {}, warn() {} },
    on(_type, fn) { listeners.push(fn) },
    agentTeams: {
      tryMembership: (agent) => (agent === reviewer
        ? { root: lead, id: LEAD, role: 'teammate', name: 'reviewer' }
        : { root: agent, id: agent.id, role: 'lead', name: 'lead' }),
      listMembers: () => [row('lead', LEAD, 'running', 'lead'), row('reviewer', REVIEWER, opts.memberStatus ?? 'running')],
      waitForChange: () => Promise.resolve({ timedOut: true }),
    },
    sessionProjections: {
      stateOf: (_session, key) => (key === 'agentTeam'
        ? { messages: opts.messages ?? [submission], delivered: opts.delivered ?? [MESSAGE] }
        : undefined),
    },
    sessions: {
      get: (id) => {
        lookups += 1
        if (id !== REVIEWER) return undefined
        if (opts.noSession) return undefined
        return typeof own === 'function' ? own(id) : fakeSession(id, own)
      },
    },
  }

  apply(ctx, CONFIG)
  const original = console.log
  console.log = () => {}
  try {
    for (const fn of listeners) fn({ agent: lead })
    reviewer.rostered = true
    for (const fn of listeners) fn({ agent: reviewer })
  } finally {
    console.log = original
  }

  const [tool] = registrations.map((r) => r.tool)
  const controller = new AbortController()
  // The verdict must not depend on waiting, and a member that is still `running`
  // would otherwise spin the loop against the real clock until the deadline.
  const value = await tool.execute({ timeout_ms: opts.timeoutMs ?? 0 }, { agent: lead, signal: controller.signal })
  return { value, text: tool.output.render({}, value)[0].text, lookups }
}

test('REACHABILITY: a member that ran a tool and then reported still meets the quorum', async () => {
  const { value, text, lookups } = await askLead(HONEST)

  assert.equal(lookups, 1, 'the gate must read the member session exactly once per verdict')
  assert.equal(value.members[0].evidence, 'verified')
  assert.equal(value.verifiedCount, 1)
  assert.equal(value.deliveredCount, 1)
  assert.equal(value.quorumMet, true, 'adding the evidence gate must not make quorum unreachable')
  assert.equal(value.timedOut, false)
  assert.match(text, /Quorum met/)
  assert.match(text, /reviewer \[running\] reported\+verified/)
})

test('a report with nothing behind it is unverified, so the quorum is not met', async () => {
  // The fabricated turn: the member only ever talked. Its own `send_message`
  // result is a tool result like any other, which is why the literal rule
  // "any successful tool/result before delivered" would have passed this.
  const onlyTalked = memberLog([report(MESSAGE)])
  const { value, text } = await askLead(onlyTalked)

  assert.equal(value.members[0].evidence, 'unverified')
  assert.equal(value.verifiedCount, 0)
  assert.equal(value.deliveredCount, 1, 'it did deliver; the report is real, the evidence is not')
  assert.equal(value.quorumMet, false)
  assert.equal(value.timedOut, true)
  assert.match(text, /reviewer \[running\] reported-but-unverified/)
  assert.match(text, /none usable as evidence before seq \d+: nothing but the report itself/)
  assert.match(text, /An unverified member still owes evidence: ask it to run the command/)
  assert.doesNotMatch(text, /Wake one with send_message/, 'the member is still running, so this is not a stall')
})

test('work that only starts after the report has been sent proves nothing', async () => {
  const late = memberLog([report(MESSAGE), { name: 'read', text: 'def add(a, b):\n    return a + b' }])
  const { value } = await askLead(late)

  assert.equal(value.members[0].evidence, 'unverified')
  assert.match(value.members[0].evidenceDetail, /work tools ran only after the report/)
  assert.equal(value.quorumMet, false)
})

test('team-protocol traffic is not evidence, even when it did run before the report', async () => {
  // `list_agents` and `todo_write` both succeed and both predate the report. If
  // either counted, a member could verify itself by looking at the roster.
  const chatter = memberLog([
    { name: 'list_agents', text: '[{"name":"lead"}]' },
    { name: 'todo_write', text: '3 tasks recorded' },
    report(MESSAGE),
  ])
  const { value } = await askLead(chatter)

  assert.equal(value.members[0].evidence, 'unverified')
  assert.match(value.members[0].evidenceDetail, /protocol-only \(list_agents, todo_write\)/)
  assert.equal(value.quorumMet, false)
})

test('a tool run that failed is not evidence', async () => {
  const allFailed = memberLog([
    { name: 'bash', text: 'command not found: pytest', ok: false },
    report(MESSAGE),
  ])
  const { value } = await askLead(allFailed)

  assert.equal(value.members[0].evidence, 'unverified')
  assert.match(value.members[0].evidenceDetail, /1 failed/)
  assert.equal(value.quorumMet, false)
})

test('a member session that is gone reads as unverifiable, never as verified', async () => {
  const { value, text, lookups } = await askLead(null, { noSession: true })

  assert.equal(lookups, 1)
  assert.equal(value.members[0].evidence, 'unverifiable')
  assert.match(value.members[0].evidenceDetail, /not loaded in this process/)
  assert.equal(value.verifiedCount, 0)
  assert.equal(value.quorumMet, false)
  assert.match(text, /reviewer \[running\] reported-but-unverifiable/)
})

test('a log that cannot be read is reported, not thrown at the Lead', async () => {
  const { value } = await askLead(() => fakeSession(REVIEWER, [], { throws: 'SESSION_LOG_LOCKED' }))

  assert.equal(value.members[0].evidence, 'unverifiable')
  assert.match(value.members[0].evidenceDetail, /SESSION_LOG_LOCKED/)
  assert.equal(value.quorumMet, false)
})

test('a fork inherits its ancestor’s tool history, and that history is not evidence', async () => {
  const ancestorWork = memberLog([{ name: 'read', text: 'inherited' }], 1)
  const own = memberLog([report(MESSAGE)], 100)
  const { value } = await askLead(() => fakeSession(REVIEWER, own, { inherited: ancestorWork }))

  assert.equal(value.members[0].evidence, 'unverified')
  assert.equal(value.quorumMet, false, "the parent's reads are not this member's work")
})

test('one evidence-backed report lifts the member, even if it reported empty-handed before', async () => {
  const second = { ...submission, id: 'team-message-9f106f1f' }
  const events = [
    ...memberLog([report(MESSAGE)], 3),
    ...memberLog([{ name: 'grep', text: 'test_add FAILED' }, report(second.id)], 20),
  ]
  const { value } = await askLead(events, { messages: [submission, second], delivered: [MESSAGE, second.id] })

  assert.equal(value.members[0].evidence, 'verified')
  assert.match(value.members[0].evidenceDetail, /grep at seq/)
  assert.equal(value.quorumMet, true)
})

test('an unverified member that has stopped running ends the wait as stalled, not as failed work', async () => {
  const { value, text } = await askLead(memberLog([report(MESSAGE)]), { memberStatus: 'inactive', timeoutMs: 60000 })

  assert.equal(value.stalled?.reason, 'no-active-member')
  assert.match(value.stalled.message, /reviewer/)
  assert.equal(value.timedOut, false, 'waiting for a member that is not running cannot pay off')
  assert.match(text, /Wake one with send_message and require the tool output/)
})

test('judgeQuorum refuses to run without an evidence resolver', () => {
  assert.throws(
    () => judgeQuorum({
      roster: [row('lead', LEAD, 'running', 'lead'), row('reviewer', REVIEWER, 'running')],
      messages: [submission],
      delivered: [MESSAGE],
      leadId: LEAD,
      requires: 1,
    }),
    /not proof of work/,
  )
})

test('a message id that never appears in the member log still needs a work tool', () => {
  const verdict = judgeEvidence({
    events: memberLog([{ name: 'bash', text: '2 passed' }, report('team-message-other')]),
    messageIds: [MESSAGE],
  })
  assert.equal(verdict.status, 'verified')
  assert.match(verdict.detail, /report not located in its log/)

  const silent = judgeEvidence({ events: memberLog([report('team-message-other')]), messageIds: [MESSAGE] })
  assert.equal(silent.status, 'unverified')
})
