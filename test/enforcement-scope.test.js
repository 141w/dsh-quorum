import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../index.js'
import { hostHarness as harness } from './fixtures/host-ctx.js'

// The stub (fixtures/host-ctx.js) mirrors upstream semantics read from
// dsh-experimental-agent-team/lib/index.js: tryMembership (397-427) resolves *any*
// agent without a live roster entry to {root: self, role: 'lead'}, and list
// (436-466) always prepends the Lead pseudo-row. A team of one is therefore
// indistinguishable from a plain session by role alone, so these tests pin the
// exemption to roster size rather than to the lead card's leniency.
const CONFIG = {
  roles: {
    lead: { shape: 'ship', writeScopes: [], maxMembers: 4 },
    reviewer: { shape: 'scout', allow: ['read', 'grep'] },
    fixer: { shape: 'ship', writeScopes: ['src/'] },
  },
  defaultRole: { shape: 'scout', allow: ['read'] },
  budget: { maxBilledTokens: 400000, softTier: 0.7, hardTier: 0.9 },
}

test('a plain session (team of one) registers neither guard nor prompt section', () => {
  const h = harness()
  apply(h.ctx, CONFIG)
  h.emit('agent/created', { agent: h.create('lead-1') })

  assert.equal(h.guards.length, 0)
  assert.equal(h.sections.length, 0)
  assert.equal(h.registrations.length, 0, 'a plain session must not gain the quorum_wait tool either')
  assert.deepEqual(h.lines.filter((l) => l.includes('[quorum]')), [], 'silent by default')
})

test('the exemption line still exists as a switch, proving exempt rather than never-fired', () => {
  const h = harness()
  apply(h.ctx, { ...CONFIG, debug: { logExemption: true } })
  h.emit('agent/created', { agent: h.create('lead-1') })

  // The only `[quorum]` output a plain session can ever produce, and it is opt-in.
  assert.deepEqual(h.lines, ['[quorum] EXEMPT team-of-one session lead-1'])
  assert.equal(h.guards.length, 0)
  assert.equal(h.sections.length, 0)
  assert.equal(h.registrations.length, 0)
})

test('the first teammate polices the Lead exactly once, plus itself', () => {
  const h = harness()
  apply(h.ctx, CONFIG)
  const lead = h.create('lead-1')
  h.emit('agent/created', { agent: lead })
  assert.equal(h.guards.length, 0, 'nothing is policed before the spawn')

  const reviewer = h.create('child-1', { parentId: 'lead-1', parentAgent: lead, name: 'reviewer' })
  h.emit('agent/created', { agent: reviewer })

  assert.deepEqual(h.lines.filter((l) => l.includes('policing')), [
    '[quorum] policing "lead" (ship) team=lead-1',
    '[quorum] policing "reviewer" (scout) team=lead-1',
  ])
  assert.equal(h.guards.filter((g) => g.agent === lead).length, 1)
  assert.equal(h.sections.length, 2)
})

test('a second teammate does not re-police the Lead', () => {
  const h = harness()
  apply(h.ctx, CONFIG)
  const lead = h.create('lead-1')
  const reviewer = h.create('child-1', { parentId: 'lead-1', parentAgent: lead, name: 'reviewer' })
  h.emit('agent/created', { agent: reviewer })
  const fixer = h.create('child-2', { parentId: 'lead-1', parentAgent: lead, name: 'fixer' })
  h.emit('agent/created', { agent: fixer })

  assert.equal(h.guards.filter((g) => g.agent === lead).length, 1)
  assert.deepEqual(h.lines.filter((l) => l.includes('policing')).map((l) => l.split('"')[1]), ['lead', 'reviewer', 'fixer'])
})

test('a recreated Lead object gets its own guard (dedupe keys on identity, not id)', () => {
  const h = harness()
  apply(h.ctx, CONFIG)
  const first = h.create('lead-1')
  h.emit('agent/created', { agent: first })
  const reviewer = h.create('child-1', { parentId: 'lead-1', parentAgent: first, name: 'reviewer' })
  h.emit('agent/created', { agent: reviewer })

  const again = h.create('lead-1')
  h.emit('agent/created', { agent: again })

  assert.equal(h.guards.filter((g) => g.agent === first).length, 1)
  assert.equal(h.guards.filter((g) => g.agent === again).length, 1)
})

test('exempting plain sessions did not weaken enforcement: scout denied, lead free', () => {
  const h = harness()
  apply(h.ctx, CONFIG)
  const lead = h.create('lead-1')
  const reviewer = h.create('child-1', { parentId: 'lead-1', parentAgent: lead, name: 'reviewer' })
  h.emit('agent/created', { agent: reviewer })
  // Writes are unlocked here on purpose: these cases are about which tool may write
  // where, and the shape gate would otherwise answer first. The gate itself is owned
  // by test/shape-gate.test.js; `lock()` puts it back.
  h.converge()

  const scout = h.guards.find((g) => g.agent === reviewer).fn
  const leadGuard = h.guards.find((g) => g.agent === lead).fn

  assert.match(scout({ name: 'write', arguments: '{"file_path":"/work/review-result.md"}' }), /shape=scout/)
  assert.match(scout({ name: 'bash' }), /is not granted the bash tool/)
  assert.equal(scout({ name: 'grep' }), undefined)
  assert.equal(leadGuard({ name: 'write', arguments: '{"file_path":"/work/calc.py"}' }), undefined)
})

// The B round of 2026-10-03 deadlocked for exactly one reason: the scout card's
// allowlist omitted send_message, so the member could never submit and the
// quorum was unreachable while every test stayed green.
test('a scout may always report back: allowlists gate mutating tools, not the voice', () => {
  const h = harness()
  apply(h.ctx, CONFIG)
  const lead = h.create('lead-1')
  const reviewer = h.create('child-1', { parentId: 'lead-1', parentAgent: lead, name: 'reviewer' })
  h.emit('agent/created', { agent: reviewer })
  const scout = h.guards.find((g) => g.agent === reviewer).fn

  assert.equal(scout({ name: 'send_message', arguments: '{"target":"lead","message":"done"}' }), undefined)
  assert.equal(scout({ name: 'present' }), undefined)
  assert.match(scout({ name: 'write', arguments: '{"file_path":"/work/review-result.md"}' }), /shape=scout/)
  assert.match(scout({ name: 'bash' }), /is not granted the bash tool/)
})

// quorum_wait can only be armed after the first teammate exists, which is after
// the Lead's prompt was already assembled. Measured live on 2026-10-03: the tool
// reached the second assembly only and the model reported it was not in its tool
// list and used wait_agent instead. The nudge is what makes the tool real.
test('arming the Lead also tells the Lead the tool now exists', () => {
  const h = harness()
  apply(h.ctx, CONFIG)
  const lead = h.create('lead-1')
  h.emit('agent/created', { agent: lead })
  assert.equal(h.injections.length, 0, 'a plain session must not be nudged')
  assert.ok(!h.lines.some((l) => l.includes('nudge failed')), 'no inject call may error')

  h.create('child-1', { parentId: 'lead-1', parentAgent: lead, name: 'reviewer' })
  h.emit('agent/created', { agent: h.roster.get('lead-1')[0].agent })

  const nudges = h.injections.filter((i) => i.agent === lead)
  assert.equal(nudges.length, 1, 'exactly one nudge per Lead')
  assert.match(nudges[0].message.content[0].text, /quorum_wait/)
  assert.ok(!h.lines.some((l) => l.includes('nudge failed')), 'no inject call may error')
})

// Cost was the one discipline with no behavioural coverage: the tiers had never
// been crossed in any test, so the degrade path was shipped as untested code.
test('cost tiers degrade in order: stop growing, then stop writing', () => {
  const h = harness()
  apply(h.ctx, CONFIG)
  const lead = h.create('lead-1')
  h.create('child-1', { parentId: 'lead-1', parentAgent: lead, name: 'reviewer' })
  h.emit('agent/created', { agent: lead })
  h.emit('agent/created', { agent: h.roster.get('lead-1')[0].agent })
  // Writes are unlocked here on purpose: these cases are about which tool may write
  // where, and the shape gate would otherwise answer first. The gate itself is owned
  // by test/shape-gate.test.js; `lock()` puts it back.
  h.converge()
  const leadGuard = h.guards.find((g) => g.agent === lead).fn

  // maxBilledTokens 400000: soft 70% = 280000, hard 90% = 360000.
  assert.equal(leadGuard({ name: 'spawn_teammate' }), undefined, 'free to grow at first')
  assert.equal(leadGuard({ name: 'write', arguments: '{"file_path":"/work/a.py"}' }), undefined)

  h.emit('session/event', lead.session, {
    type: 'assistant/message', data: { message: { usage: { inputTokens: 200000, outputTokens: 90000 } } },
  })
  assert.match(leadGuard({ name: 'spawn_teammate' }), /cost budget reached 7/, 'soft tier stops growth')
  assert.equal(leadGuard({ name: 'write', arguments: '{"file_path":"/work/a.py"}' }), undefined, 'soft tier still writes')

  h.emit('session/event', lead.session, {
    type: 'assistant/message', data: { message: { usage: { inputTokens: 80000, outputTokens: 40000 } } },
  })
  assert.match(leadGuard({ name: 'write', arguments: '{"file_path":"/work/a.py"}' }), /report-only mode/, 'hard tier stops writes')
  assert.match(leadGuard({ name: 'spawn_teammate' }), /cost budget reached 10/, 'past 100% still cannot grow')
})
