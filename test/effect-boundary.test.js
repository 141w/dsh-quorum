import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../index.js'
import { hostHarness } from './fixtures/host-ctx.js'

// The effect boundary, as opposed to the tool boundary.
//
// Every discipline in this bundle is enforced at one place: `tools.guard()` looking at
// a tool *name*. That is sound for `write`/`edit`/`multiedit`/`str_replace_editor`, and
// it is unsound for anything that reaches the filesystem through a different door. The
// runtime ships `run_code` — a tool whose own description says the agent "uses run_code
// to write a TypeScript program", and whose docs show a declared `bash` binding being
// called from inside it. A call to `run_code` is not in `WRITE_TOOLS`, so it is not a
// write as far as this file is concerned.
//
// These cases are written as the specification I am proposing, not as a description of
// current behaviour, and they are red until the guard classifies effects rather than
// names. Read the failure output as the size of the hole.
//
// What this file deliberately does NOT claim: that the plugin can see *inside* a
// `run_code` program. It cannot — the guard gets a name and an argument string. So the
// only enforceable rule at this boundary is "a locked team does not get an
// arbitrary-effect tool", and the honest cost of that rule is case 4 below: a member
// whose only way to produce evidence is `run_code` can never produce it, which is the
// same class of problem as an empty grant at spawn.

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
 * @param names - teammate card names to arm alongside the Lead.
 * @param opts - `{config?}` to vary the role cards per case.
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
      status: 'running',
      evidenced: true,
    })
    h.emit('agent/created', { agent })
    return agent
  })
  const guard = (agent) => h.guards.find((g) => g.agent === agent)?.fn
  const call = (agent, name, args) => guard(agent)?.({ name, arguments: JSON.stringify(args) })
  return { h, lead, members, call }
}

const WRITING_CODE = 'const {writeFile} = await import("node:fs/promises"); await writeFile("/work/src/a.py", "x")'

test('EFFECT BOUNDARY: a locked team does not get run_code from the Lead', () => {
  const { lead, call } = squad(['reviewer'])
  const verdict = call(lead, 'run_code', { code: WRITING_CODE })
  assert.match(String(verdict), /still in scout shape/,
    'the shape gate must bind the Lead through run_code too, or "the Lead included" is false')
})

test('EFFECT BOUNDARY: a scout card granting run_code is refused at activation', () => {
  // Current validator: SHELL_TOOLS is {bash, pwsh}. `run_code` passes it, so a card can
  // be configured as shape=scout while holding a tool that writes any path.
  assert.throws(
    () => apply(hostHarness().ctx, {
      ...CONFIG,
      roles: { ...CONFIG.roles, reviewer: { shape: 'scout', allow: ['read', 'run_code'] } },
    }),
    /run_code/,
    'a shell-by-another-name must trip the same contradiction bash does',
  )
})

test('EFFECT BOUNDARY: a ship member cannot route around writeScopes through run_code', () => {
  const { h, lead, members, call } = squad(['reviewer', 'fixer'])
  h.converge('lead-1')
  const verdict = call(members[1], 'run_code', { code: WRITING_CODE })
  assert.match(String(verdict), /is confined to \[src\/\]/,
    'scope discipline has to survive the substitution of a different tool name')
  assert.match(String(verdict), /run_code runs a program that can write anywhere/,
    'and say why this call is different from an out-of-scope path')
})

test('EFFECT BOUNDARY: an unrestricted card does get run_code once the quorum is met', () => {
  const { h, lead, call } = squad(['reviewer'])
  h.converge('lead-1')
  // The Lead card ships with `writeScopes: []`, i.e. confinement was never promised,
  // and the shape gate has been passed. Denying here would make the rule permanent
  // rather than a sequence, and would break the very rounds D13 proves work.
  assert.equal(call(lead, 'run_code', { code: WRITING_CODE }), undefined,
    'after convergence an unrestricted Lead may run code — that is what "ship" means')
})

// ── The other half of the same hole: a grant list that names nothing callable ──

test('SPAWN: a card granting only uncallable names is refused at the boundary', () => {
  const { h, lead, call } = squad(['reviewer'], {
    config: { roles: { lead: { shape: 'ship', writeScopes: [], maxMembers: 4 }, ghost: { shape: 'ship', allow: ['read_fil', 'grep_tx'] } } },
  })
  const verdict = call(lead, 'spawn_teammate', { name: 'ghost', prompt: 'x' })
  assert.match(String(verdict), /would start a member that can do nothing/,
    'a typo in an allow list is otherwise a silent, session-permanent lock')
  assert.match(String(verdict), /\[read_fil, grep_tx\]/, 'and the refusal names what was asked for')
})

test('SPAWN: a card whose grant list contains one callable name is not blocked', () => {
  const { lead, call } = squad(['reviewer'], {
    config: { roles: { lead: { shape: 'ship', writeScopes: [], maxMembers: 4 }, mixed: { shape: 'scout', allow: ['read', 'not_a_tool'] } } },
  })
  assert.equal(call(lead, 'spawn_teammate', { name: 'mixed', prompt: 'x' }), undefined,
    'one live name is enough: this check catches dead cards, not sloppy ones')
})

test('SPAWN: a card with no allow list is not blocked by the check', () => {
  const { lead, call } = squad(['reviewer'], {
    config: { roles: { lead: { shape: 'ship', writeScopes: [], maxMembers: 4 }, wide: { shape: 'ship' } } },
  })
  // No allow list means the runtime default, which is by definition callable.
  assert.equal(call(lead, 'spawn_teammate', { name: 'wide', prompt: 'x' }), undefined)
})

test('SPAWN: the check fails open when the runtime exposes no tool lookup', () => {
  const { lead, call } = squad(['reviewer'], {
    config: { roles: { lead: { shape: 'ship', writeScopes: [], maxMembers: 4 }, ghost: { shape: 'ship', allow: ['read_fil'] } } },
  })
  delete lead.ctx.tools.get
  assert.equal(call(lead, 'spawn_teammate', { name: 'ghost', prompt: 'x' }), undefined,
    'a diagnostic must never become the reason a team cannot start')
})

test('SPAWN: a lookup that cannot name the tool it is inside disqualifies itself', () => {
  const { lead, call } = squad(['reviewer'], {
    config: { roles: { lead: { shape: 'ship', writeScopes: [], maxMembers: 4 }, ghost: { shape: 'ship', allow: ['read_fil'] } } },
  })
  // This is the runtime as docs/architecture.md measured it: `get()` answers undefined
  // even for tools that demonstrably execute, because presets moved them onto the agent
  // plane. `spawn_teammate` is executing right now, so a lookup blind to it is blind,
  // and the positive control is what tells us so.
  lead.ctx.tools.get = () => undefined
  assert.equal(call(lead, 'spawn_teammate', { name: 'ghost', prompt: 'x' }), undefined,
    'blind catalog → no verdict, not a denial')
})

test('SPAWN: a live card still spawns when the lookup is trustworthy', () => {
  const { lead, call } = squad(['reviewer'])
  assert.equal(call(lead, 'spawn_teammate', { name: 'reviewer', prompt: 'x' }), undefined)
})



test('EFFECT BOUNDARY: read-only work still runs, so the rule is not a blunt instrument', () => {
  const { lead, call } = squad(['reviewer'])
  // The cost of binding run_code: a locked team cannot compute with it either. If this
  // assertion ever becomes annoying enough to want an exception, that exception is the
  // hole re-opening, and it should be argued in docs/architecture.md rather than coded.
  const verdict = call(lead, 'run_code', { code: 'return 1 + 1' })
  assert.match(String(verdict), /still in scout shape/, 'denied for now, along with everything else')
})
