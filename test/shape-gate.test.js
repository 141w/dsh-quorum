import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../index.js'
import { hostHarness } from './fixtures/host-ctx.js'

// Discipline B's last empty cell: *when* a team is allowed to touch the checkout.
// Until now the shapes were declared but never enforced as a sequence — a `ship` card
// could write on the very first step, with zero reports in, which is the failure mode
// the scout/ship split exists to prevent. `docs/architecture.md` records that the
// judgement, the wait and the evidence gate were built (D3b, D4); this is the switch.
//
// Two things this file has to prove, because both have bitten this repo before:
//   1. **Reachability.** B1 deadlocked for a missing `send_message` in an allowlist and
//      12 green tests missed it. A gate that can never open is worse than no gate.
//   2. **No bypass, no waiver.** The Lead card ships with `writeScopes: []`
//      (unrestricted), so if only members were gated the Lead could simply write the
//      file itself — the gate would be decoration.
const CONFIG = {
  roles: {
    lead: { shape: 'ship', writeScopes: [], maxMembers: 4 },
    reviewer: { shape: 'scout', allow: ['read', 'grep'] },
    fixer: { shape: 'ship', writeScopes: ['src/'] },
  },
  defaultRole: { shape: 'scout', allow: ['read'] },
  budget: { maxBilledTokens: 2000000, softTier: 0.7, hardTier: 0.9 },
  quorum: { requires: 'all', timeoutMs: 300000, pollMs: 30000 },
}

/**
 * Arm a Lead plus the named members and hand back their guards.
 * @param names - teammate card names, in creation order.
 * @param opts - `{config?, statuses?, evidenced?}` for the shape of the team record.
 */
function squad(names, opts = {}) {
  const h = hostHarness()
  apply(h.ctx, { ...CONFIG, ...opts.config })
  const lead = h.create('lead-1')
  const members = names.map((name, i) => {
    const agent = h.create(`child-${i + 1}`, {
      parentId: 'lead-1',
      parentAgent: lead,
      name,
      status: opts.statuses?.[name] ?? 'running',
      evidenced: opts.evidenced?.[name] !== false,
    })
    h.emit('agent/created', { agent })
    return agent
  })
  const guard = (agent) => h.guards.find((g) => g.agent === agent)?.fn
  // /work/src/a.py, not /src/a.py: the `fixer` card grants the workspace-relative
  // scope `src/`, and these cases are about the shape gate, not about path maths
  // (capability-boundary.test.js owns those).
  const write = (agent) => guard(agent)?.({ name: 'write', arguments: '{"file_path":"/work/src/a.py"}' })
  return { h, lead, members, guard, write }
}

// ── 1. It is on by default, and it binds the Lead ──

test('GATE: with no reports in, the Lead is refused — the bypass path is closed', () => {
  const { h, lead, write } = squad(['reviewer', 'fixer'])
  assert.match(write(lead), /still in scout shape/, 'the Lead cannot write around its own members')
  assert.match(write(lead), /0\/2 verified/, 'and the reason states the numbers, not a mood')
  assert.match(write(lead), /not waivable/)
  assert.equal(h.lines.filter((l) => l.includes('policing')).length, 3, 'Lead + 2 members')
})

test('GATE: a ship member is refused too, while a scout keeps its own reason', () => {
  const { lead, members, guard } = squad(['reviewer', 'fixer'])
  assert.match(guard(members[1])({ name: 'write', arguments: '{"file_path":"/src/a.py"}' }), /still in scout shape/)
  assert.match(guard(members[0])({ name: 'write', arguments: '{"file_path":"/src/a.py"}' }), /shape=scout/,
    'a scout is read-only by construction, which is a different fact than "not yet"')
})

// ── 2. Reachability: the gate must be openable by real work ──

test('GATE REACHABILITY: reports backed by tool evidence unlock the Lead and the fixer', () => {
  const { h, lead, members, write } = squad(['reviewer', 'fixer'])
  h.converge('lead-1')
  assert.equal(write(lead), undefined, 'the Lead may write once the quorum is met')
  assert.equal(write(members[1]), undefined, 'and so may the ship member')
  assert.match(write(members[0]), /shape=scout/, 'the scout is still a scout: convergence does not promote a card')
})

test('GATE: a delivered report with nothing behind it does not unlock', () => {
  const { h, lead, write } = squad(['reviewer', 'fixer'], { evidenced: { fixer: false } })
  h.converge('lead-1')
  assert.match(write(lead), /still in scout shape/)
  assert.match(write(lead), /1\/2 verified/, 'the fabricated half is counted as outstanding')
  assert.match(write(lead), /fixer \[running\] unverified/, 'and named, so the Lead knows who to chase')
})

test('GATE: the verdict follows the record, and only recomputes when it moves', () => {
  const { h, lead, write } = squad(['reviewer'])
  assert.match(write(lead), /still in scout shape/)
  const afterFirst = h.evidenceReads.length
  write(lead)
  write(lead)
  assert.equal(h.evidenceReads.length, afterFirst, 'an unchanged Team record must not re-read member logs')

  h.converge('lead-1')
  assert.equal(write(lead), undefined, 'and a changed one must not be served from the cache')
  assert.ok(h.evidenceReads.length > afterFirst, 'the reopen really did re-read')
})

test('GATE: an idle member does not pull a converged team back into scout', () => {
  // The D12 scenario, reproduced from the transcript: both members read a file and
  // delivered, `quorum_wait` scored 1/2 at seq 122, and six events later the same
  // question answered 0/2 — not because anything changed in the logs, but because both
  // sessions had been released from the process. With writes gated on that number, the
  // team was locked by a verdict that could regress backwards.
  const { h, lead, members, write } = squad(['reviewer', 'fixer'])
  h.converge('lead-1')
  assert.equal(write(lead), undefined, 'converged: the Lead may write')

  h.release(members[0].id)
  h.release(members[1].id)
  h.converge('lead-1')
  assert.equal(write(lead), undefined, 'idle members do not un-earn what their logs already showed')
  assert.equal(write(members[1]), undefined, 'and the ship member stays able to write')

  // Without a single report ever being readable, the same release must still hold shut:
  // this is the half of the fix that must not become a way to pass on delivery alone.
  const locked = squad(['reviewer'])
  locked.h.release(locked.members[0].id)
  locked.h.converge('lead-1')
  assert.match(locked.write(locked.lead), /still in scout shape/, 'a never-read log is still not evidence')
})

// ── 3. It cannot be talked around ──

test('GATE: while locked, reading and reporting still work, so no team deadlocks', () => {
  const { h, lead, members, guard } = squad(['reviewer'])
  const scout = guard(members[0])
  const leadGuard = guard(lead)
  assert.equal(scout({ name: 'read', arguments: '{"file_path":"/src/a.py"}' }), undefined, 'evidence is still obtainable')
  assert.equal(scout({ name: 'send_message', arguments: '{"to":"lead"}' }), undefined, 'and still submittable')
  assert.equal(leadGuard({ name: 'quorum_wait' }), undefined, 'the Lead keeps the one tool that tells it what to do')
  assert.equal(leadGuard({ name: 'spawn_teammate' }), undefined, 'and it can still staff up to get there')
  assert.equal(h.lines.filter((l) => l.includes('[quorum] denied')).length, 0, 'none of that was refused')
})

test('GATE: a stalled team is told its real options, not left waiting', () => {
  const { h, lead, write } = squad(['reviewer', 'fixer'], { statuses: { fixer: 'inactive' }, evidenced: { fixer: false } })
  h.converge('lead-1')
  const verdict = write(lead)
  assert.match(verdict, /still in scout shape/)
  assert.match(verdict, /fixer \[inactive\]/, 'the member that is not running is named as such')
  assert.match(verdict, /Wake one with send_message|conclude this round as report-only/, 'and the two exits are both on the page')
  assert.match(verdict, /config\.quorum\.requires/, 'the only lever is config, stated as config')
})

test('GATE: an unreadable Team record holds the lock instead of waving it through', () => {
  const { h, lead, write } = squad(['reviewer'])
  h.unloadProjection()
  assert.match(write(lead), /not loaded in this process/, 'fail closed on "cannot tell"')
  assert.match(write(lead), /Held locked rather than allowed through unmeasured/)
})

test('GATE: an explicit false is honoured, and it is the only way to get a free pass', () => {
  // The escape hatch is a config edit made outside the round, which is what makes it a
  // decision rather than a negotiation with the agent mid-task.
  const { h, lead, write } = squad(['reviewer'], { config: { transition: { gateWritesOnQuorum: false } } })
  assert.equal(write(lead), undefined, 'a comparison round writes with the gate off')
  assert.equal(h.lines.filter((l) => l.includes('policing')).length, 2)
})

// ── 4. The configuration is honest about what it can say ──

test('GATE: a waiver key is refused at activation, not quietly ignored', () => {
  const h = hostHarness()
  assert.throws(
    () => apply(h.ctx, { ...CONFIG, transition: { waiver: 'lead' } }),
    /config\.transition\.waiver is not a recognized key[\s\S]*prompt convention/,
  )
})

test('GATE: gateWritesOnQuorum must be a boolean, and the row is refused otherwise', () => {
  const h = hostHarness()
  assert.throws(
    () => apply(h.ctx, { ...CONFIG, transition: { gateWritesOnQuorum: 'yes' } }),
    /config\.transition\.gateWritesOnQuorum must be true or false/,
  )
  assert.throws(() => apply(h.ctx, { ...CONFIG, transition: 'all' }), /config\.transition must be an object/)
  assert.doesNotThrow(() => apply(h.ctx, CONFIG), 'omitting the block is valid: the gate defaults on')
})

test('GATE: the card declared to the model states the switch', () => {
  const { h, members } = squad(['reviewer'])
  const section = h.sections.find((s) => s.agent === members[0])
  assert.match(section.text, /your team starts in scout/)
  assert.match(section.text, /This is not waivable/)
  assert.equal(h.sections.length, 2, 'Lead and the teammate each get their own declaration')
})
