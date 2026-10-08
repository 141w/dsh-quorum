import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../index.js'
import { hostHarness } from './fixtures/host-ctx.js'

// Upstream makes teardown a two-owner contract, and this bundle had neither owner:
//
//   references/practices.md:19 — "Register per-agent behavior on `agent.ctx` … so it
//   is removed when that agent is disposed. Wrap it in one `agent.ctx.effect()` and
//   ALSO keep that disposer, keyed by agent, in your plugin's own effect; unloading
//   the plugin does not dispose `agent.ctx` registrations by itself."
//
// Before this file, `guard()`, `register()` and `systemPrompt.section()` disposers
// were dropped on the floor, and `spend`/`sessionTeam`/`policed` grew for the
// lifetime of the process. Every case below is a *behavioural* assertion — what a
// registration list or a budget does after a teardown — because "the map is smaller"
// is not observable from outside and would not fail if the cleanup were a no-op.
const CONFIG = {
  roles: {
    lead: { shape: 'ship', writeScopes: [], maxMembers: 4 },
    reviewer: { shape: 'scout', allow: ['read', 'grep'] },
    fixer: { shape: 'ship', writeScopes: ['src/'] },
  },
  defaultRole: { shape: 'scout', allow: ['read'] },
  budget: { maxBilledTokens: 400000, softTier: 0.7, hardTier: 0.9 },
  quorum: { requires: 'all', timeoutMs: 300000, pollMs: 30000 },
}

/** Arm one Lead + one teammate and hand back both. */
function team(opts = {}) {
  const h = hostHarness()
  apply(h.ctx, CONFIG)
  const lead = h.create('lead-1')
  h.emit('agent/created', { agent: lead })
  const member = h.create('child-1', { parentId: 'lead-1', parentAgent: lead, name: opts.name ?? 'reviewer', ...opts.member })
  h.emit('agent/created', { agent: member })
  return { h, lead, member }
}

const guardOf = (h, agent) => h.guards.find((g) => g.agent === agent)?.fn
const usage = (tokens) => ({ type: 'assistant/message', data: { message: { usage: { inputTokens: tokens, outputTokens: 0 } } } })

// ── 1. The agent's own scope is a real owner ──

test('the agent scope owns the registrations: disposing it unarms guard, tool and prompt', () => {
  const { h, lead, member } = team()
  assert.equal(h.guards.length, 2)
  assert.equal(h.sections.length, 2)
  assert.equal(h.registrations.length, 1, 'only the Lead gains quorum_wait')

  // This is the half `agent.ctx.effect()` buys: the host tears it down itself.
  lead.dispose()

  assert.equal(h.guards.filter((g) => g.agent === lead).length, 0, 'the Lead guard is gone')
  assert.equal(h.registrations.length, 0, 'the Lead tool is gone')
  assert.equal(h.sections.filter((s) => s.agent === lead).length, 0, 'the Lead prompt section is gone')
  assert.equal(h.guards.filter((g) => g.agent === member).length, 1, 'the teammate is untouched')
})

// ── 2. The plugin keeps the other owner's handle ──

test('agent/disposed runs the plugin-side disposer and drops the Agent reference', () => {
  const { h, lead } = team()
  h.emit('agent/disposed', { agent: lead })

  assert.equal(h.guards.filter((g) => g.agent === lead).length, 0)
  assert.equal(h.registrations.length, 0)
  assert.deepEqual(h.disposed.filter((l) => l.includes('lead')), [
    'ctx:quorum: lead',
    'agent(lead-1):quorum: lead',
  ], 'the plugin-side effect must own the agent-side effect, in that nesting')
})

test('agent/disposed twice is a no-op, and an agent that was never policed is ignored', () => {
  const { h, lead } = team()
  const plain = h.create('lead-2')
  h.emit('agent/created', { agent: plain })

  h.emit('agent/disposed', { agent: lead })
  assert.doesNotThrow(() => h.emit('agent/disposed', { agent: lead }))
  // A team-of-one session was never armed, so tearing it down must not disturb the
  // Lead's registrations that are still live — dedupe and teardown key on the object.
  assert.doesNotThrow(() => h.emit('agent/disposed', { agent: plain }))
  assert.equal(h.guards.length, 1, 'only the teammate is still policed')
})

test('unloading the plugin unarms every agent still registered', () => {
  const { h } = team()
  assert.equal(h.guards.length, 2)

  // practices.md:19 says the runtime will not do this for us.
  h.unload()

  assert.equal(h.guards.length, 0, 'no guard outlives the bundle')
  assert.equal(h.sections.length, 0)
  assert.equal(h.registrations.length, 0)
})

test('a disposed guard stops denying: the mechanism is really uninstalled, not hidden', () => {
  const { h, member } = team()
  assert.match(guardOf(h, member)({ name: 'write', arguments: '{"file_path":"/work/x.md"}' }), /shape=scout/)

  member.dispose()

  assert.equal(guardOf(h, member), undefined, 'the host no longer holds this agent at all')
})

// ── 3. The ledgers have a named end, and the reset it costs ──

test('a member session leaving keeps the team ledger; the Lead leaving drops it', () => {
  const { h, lead, member } = team()
  h.converge()
  const write = () => guardOf(h, lead)({ name: 'write', arguments: '{"file_path":"/work/a.py"}' })
  assert.equal(write(), undefined, 'free to write at first')

  h.emit('session/event', member.session, usage(400000))
  assert.match(write(), /report-only mode/, 'the member’s spend is charged to the team')

  // Dropping a member's ledger would be the failure this whole discipline exists to
  // prevent: restarting the slowest member would hand the team a fresh allowance.
  h.emit('session/disposed', member.session)
  assert.match(write(), /report-only mode/, 'a member leaving must not zero the budget')

  h.emit('session/event', member.session, usage(400000))
  assert.match(write(), /reached 100%/, 'a disposed session must stop accruing, not double-count')

  // The Lead's own session leaving IS the team ending (`TeamId` is that session id
  // branded), so the ledger goes with it — and so does the shape gate's ability to
  // evaluate anything. The surviving agent must be refused, not waved through: a dead
  // team writing to disk is not a discipline, and "allowed because we can no longer
  // tell" is the no-op-shaped failure this file keeps having to name.
  h.emit('session/disposed', lead.session)
  assert.match(write(), /no live Lead Agent/, 'the ended team stops writing')

  // A reopened team (new Agent objects, same durable ids) starts from zero spend. This
  // is the price of a bounded ledger, stated in docs/architecture.md: the accounting is
  // scoped to process x session residency, exactly as evidence resolution already was.
  const lead2 = h.create('lead-1')
  h.emit('agent/created', { agent: lead2 })
  const auditor = h.create('child-9', { parentId: 'lead-1', parentAgent: lead2, name: 'auditor' })
  h.emit('agent/created', { agent: auditor })
  h.converge('lead-1')
  const write2 = () => guardOf(h, lead2)({ name: 'write', arguments: '{"file_path":"/work/a.py"}' })
  assert.equal(write2(), undefined, 'a reopened team gets a fresh budget')
  h.emit('session/event', lead2.session, usage(400000))
  assert.match(write2(), /report-only mode/, 'and it can still cross its own tiers')
})

test('session routing is keyed by a real session id, never by undefined', () => {
  const h = hostHarness()
  apply(h.ctx, CONFIG)
  const lead = h.create('lead-1')
  h.emit('agent/created', { agent: lead })
  // A session-less agent still gets policed — failing to route it must not disable
  // the mechanism — but it may not put a `undefined` key into the routing map, which
  // no teardown could ever name.
  const ghost = h.create('child-2', { parentId: 'lead-1', parentAgent: lead, name: 'fixer', noSession: true })
  assert.doesNotThrow(() => h.emit('agent/created', { agent: ghost }))
  assert.equal(h.guards.filter((g) => g.agent === ghost).length, 1, 'policed anyway')

  const leadGuard = () => guardOf(h, lead)({ name: 'write', arguments: '{"file_path":"/work/a.py"}' })
  // The gate is open for this case: what is under test is session routing,
  // not which shape the team is in.
  h.converge()
  h.emit('session/event', { id: undefined }, usage(400000))
  assert.equal(leadGuard(), undefined, 'a keyless session may not spend the team’s budget')

  h.emit('session/event', lead.session, usage(400000))
  assert.match(leadGuard(), /report-only mode/, 'a routed session still spends it')
})

test('a fresh Lead object for the same id gets its own guard after the old one died', () => {
  const { h, lead } = team()
  h.emit('agent/disposed', { agent: lead })
  assert.equal(h.guards.filter((g) => g.agent === lead).length, 0)

  // Same durable id, new live Agent — dedupe keys on object identity, so this must
  // re-arm rather than be swallowed by the map entry the old object left behind.
  const again = h.create('lead-1')
  h.emit('agent/created', { agent: again })
  assert.equal(h.guards.filter((g) => g.agent === again).length, 1)
  assert.equal(h.registrations.filter((r) => r.agent === again).length, 1)
})
