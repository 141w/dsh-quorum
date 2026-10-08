import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../index.js'
import { hostHarness } from './fixtures/host-ctx.js'

// D12's live round produced the refusal texts and then produced something worse than a
// missing test: a verdict that got *worse* while nothing in either log changed. The
// reviewer had read calc.py and delivered two reports, the fixer had read test_calc.py
// and delivered one, `quorum_wait` scored it `1/2` at seq 122 — and six events later the
// same question answered `0/2`, because both members had meanwhile gone idle and
// `ctx.sessions.get()` no longer returned them. Evidence was being computed at query
// time, so a durable fact was held hostage to process residency, and the shape gate
// acted on the regression.
//
// The fix is to judge the report while its author's log is open and keep that verdict.
// These four cases are the boundary of that claim: memory must not fabricate (a log
// never read is still unknown), must not override (a live read always wins), and must
// not outlive the team that earned it.
const CONFIG = {
  roles: {
    lead: { shape: 'ship', writeScopes: [], maxMembers: 4 },
    reviewer: { shape: 'scout', allow: ['read', 'grep'] },
  },
  defaultRole: { shape: 'scout', allow: ['read'] },
  budget: { maxBilledTokens: 2000000, softTier: 0.7, hardTier: 0.9 },
  quorum: { requires: 'all', timeoutMs: 300000, pollMs: 30000 },
}

/** Arm a Lead plus one teammate named `name` under `teamId`, and return its quorum_wait. */
function armed(teamId = 'lead-1', name = 'reviewer') {
  const h = hostHarness()
  apply(h.ctx, CONFIG)
  const lead = h.create(teamId)
  h.emit('agent/created', { agent: lead })
  const member = h.create(`${teamId}__child`, { parentId: teamId, parentAgent: lead, name })
  h.emit('agent/created', { agent: member })
  const tool = h.registrations.find((r) => r.agent === lead)?.tool
  const ask = async () => {
    const controller = new AbortController()
    return await tool.execute({ timeout_ms: 0 }, { agent: lead, signal: controller.signal })
  }
  return { h, lead, member, tool, ask }
}

test('MEMORY: a verdict earned from a readable log survives the member going idle', async () => {
  const { h, member, ask } = armed()
  h.converge('lead-1')
  const first = await ask()
  assert.equal(first.members[0].evidence, 'verified', 'the fixture member did run a tool before reporting')
  assert.equal(first.quorumMet, true)

  // This is the D12 moment: the session is gone, the mailbox still shows the delivery,
  // and the log on disk still holds the read. Only availability changed.
  h.release(member.id)
  h.converge('lead-1')
  const second = await ask()
  assert.equal(second.members[0].evidence, 'verified', 'the earned verdict does not regress')
  assert.equal(second.quorumMet, true, 'and the quorum cannot shrink because time passed')
  assert.match(second.members[0].evidenceDetail, /read at seq/, 'the detail still cites the real tool result')
})

test('MEMORY: a log that was never readable is still unverifiable, not remembered into existence', async () => {
  const { h, member, ask } = armed()
  h.release(member.id)
  h.converge('lead-1')
  const verdict = await ask()
  assert.equal(verdict.members[0].evidence, 'unverifiable', 'no read ever happened, so nothing was earned')
  assert.equal(verdict.quorumMet, false, 'and the gate must not be satisfied by a delivery alone')

  // Once the session comes back, the real read decides — the missing memory does not
  // poison the member permanently.
  const h2 = hostHarness()
  apply(h2.ctx, CONFIG)
  const lead2 = h2.create('lead-1')
  h2.emit('agent/created', { agent: lead2 })
  const member2 = h2.create('lead-1__child', { parentId: 'lead-1', parentAgent: lead2, name: 'reviewer' })
  h2.emit('agent/created', { agent: member2 })
  h2.converge('lead-1')
  const controller = new AbortController()
  const after = await h2.registrations.find((r) => r.agent === lead2).tool
    .execute({ timeout_ms: 0 }, { agent: lead2, signal: controller.signal })
  assert.equal(after.members[0].evidence, 'verified', 'readable again means judged again')
})

test('MEMORY: a live read always outranks what was remembered', async () => {
  const { h, member, ask } = armed()
  h.converge('lead-1')
  const first = await ask()
  assert.equal(first.members[0].evidence, 'verified')

  // A real session log is append-only, so "the evidence disappeared" cannot happen
  // upstream; the knob exists to prove the ordering. If the memory ever won over a
  // readable log, a member could be stuck on a stale verdict in the other direction
  // too, and nobody would be able to see why.
  const row = h.roster.get('lead-1').find((r) => r.agent.id === member.id)
  row.evidenced = false
  h.converge('lead-1')
  const second = await ask()
  assert.equal(second.members[0].evidence, 'unverified', 'the current log decides while it is readable')
})

test('MEMORY: verdicts end with the team and cannot bleed into an unrelated one', async () => {
  const { h, lead, member, ask } = armed()
  h.converge('lead-1')
  const first = await ask()
  assert.equal(first.members[0].evidence, 'verified')

  // The team ends, so everything it earned goes with it.
  h.emit('session/disposed', lead.session)
  h.release(member.id)

  // A second, unrelated team that happens to present the same message id must not
  // inherit the first team's verdict. Real ids are `team-message-<uuid>` (the D12
  // transcript shows `team-message-09f644eb-…`), so this collision cannot occur
  // upstream — it is reachable here precisely because the fixture derives ids from
  // names, which makes it the cheapest way to pin the scoping.
  const lead2 = h.create('lead-2')
  h.emit('agent/created', { agent: lead2 })
  const member2 = h.create('lead-2__child', { parentId: 'lead-2', parentAgent: lead2, name: 'reviewer' })
  h.emit('agent/created', { agent: member2 })
  h.release(member2.id)
  h.converge('lead-2')
  const tool2 = h.registrations.find((r) => r.agent === lead2).tool
  const controller = new AbortController()
  const verdict = await tool2.execute({ timeout_ms: 0 }, { agent: lead2, signal: controller.signal })
  assert.equal(verdict.members.length, 1, 'the new team sees only its own member')
  assert.equal(verdict.members[0].evidence, 'unverifiable', 'and earns nothing from a stranger team’s read')
})
