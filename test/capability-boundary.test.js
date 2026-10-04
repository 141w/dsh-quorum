import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../index.js'

// M2: the holes the M1 audit found, pinned as tests BEFORE the fix.
//
// Each case below passes today in the sense that it documents real behaviour —
// but it documents behaviour that contradicts the product claim. The capability
// discipline says "a role cannot do what it was not granted"; these show a role
// doing exactly that. Tests are written first so the fix has a judgement, not an
// opinion, and so a later regression fails loudly instead of silently reopening
// the hole.
//
// Reference for the real tool names, read from the installed runtime:
//   write / edit            dsh-tool-fs/lib/index.js:527,675
//   str_replace_editor      dsh-tool-str-replace-editor/lib/index.js:267  (args: path)
//   bash / pwsh             dsh-tool-bash, dsh-tool-pwsh
// `multiedit` does not exist in this runtime; it is kept in the set defensively.

const CONFIG = {
  roles: {
    lead: { shape: 'ship', writeScopes: [], maxMembers: 4 },
    reviewer: { shape: 'scout', allow: ['read', 'grep'] },
    fixer: { shape: 'ship', writeScopes: ['src/', 'tests/'] },
  },
  defaultRole: { shape: 'scout', allow: ['read'] },
  budget: { maxBilledTokens: 2000000, softTier: 0.7, hardTier: 0.9 },
  quorum: { requires: 'all', timeoutMs: 300000, pollMs: 30000 },
}

function harness() {
  const roster = new Map()
  const guards = []
  const sections = []
  const registrations = []
  const lines = []
  const injections = []
  const listeners = new Map()

  const ctx = {
    logger: { info() {}, warn() {} },
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, [])
      listeners.get(type).push(fn)
    },
    agentTeams: {
      tryMembership(agent) {
        const member = (roster.get(agent.parentId) ?? []).find((m) => m.agent === agent)
        if (member) return { root: agent.parentAgent, id: agent.parentId, role: 'teammate', name: member.name }
        if (agent.subagent) return undefined
        return { root: agent, id: agent.id, role: 'lead', name: 'lead' }
      },
      listMembers(agent) {
        const teamId = agent.parentId ?? agent.id
        return [{ name: 'lead' }, ...(roster.get(teamId) ?? []).map((m) => ({ name: m.name }))]
      },
    },
  }

  const create = (id, opts = {}) => {
    const self = {
      id,
      parentId: opts.parentId,
      parentAgent: opts.parentAgent,
      subagent: false,
      session: { id, cwd: opts.cwd ?? '/work' },
      inject(message) { injections.push({ agent: self, message }) },
    }
    self.ctx = {
      tools: {
        guard(fn) { guards.push({ agent: self, fn }) },
        register(tool) { registrations.push({ agent: self, tool }) },
      },
      systemPrompt: { section(s) { sections.push({ agent: self, ...s }) } },
    }
    if (opts.parentId) {
      if (!roster.has(opts.parentId)) roster.set(opts.parentId, [])
      roster.get(opts.parentId).push({ agent: self, name: opts.name })
    }
    return self
  }

  const emit = (type, ...args) => {
    const original = console.log
    console.log = (...rest) => lines.push(rest.join(' '))
    try {
      for (const fn of listeners.get(type) ?? []) fn(...args)
    } finally {
      console.log = original
    }
  }

  return { ctx, create, emit, guards, sections, registrations, lines, injections, roster }
}

/** Police one team and hand back the guard bound to the named role. */
function guarded(name, roleOverrides = {}, session = {}) {
  const h = harness()
  apply(h.ctx, { ...CONFIG, roles: { ...CONFIG.roles, ...roleOverrides } })
  const lead = h.create('lead-1')
  const member = h.create('child-1', { parentId: 'lead-1', parentAgent: lead, name, ...session })
  h.emit('agent/created', { agent: member })
  return { h, member, guard: h.guards.find((g) => g.agent === member).fn }
}

// ── 1. Capability: the write-scope guard must cover every write-capable tool ──

test('CAPABILITY: str_replace_editor is a write tool and is scope-checked', () => {
  const { guard } = guarded('fixer')
  // `create` writes; `str_replace`/`insert` mutate. All three take a `path`.
  for (const command of ['create', 'str_replace', 'insert']) {
    assert.match(
      guard({ name: 'str_replace_editor', arguments: JSON.stringify({ command, path: '/work/NOTES.md' }) }),
      /outside the write scopes/,
      `str_replace_editor:${command} must be denied outside the granted scopes`,
    )
  }
  assert.equal(
    guard({ name: 'str_replace_editor', arguments: JSON.stringify({ command: 'create', path: '/work/src/a.py' }) }),
    undefined,
    'a path inside the granted scopes stays allowed',
  )
})

test('CAPABILITY: a scout cannot reach a write through str_replace_editor', () => {
  const { guard } = guarded('reviewer')
  assert.match(
    guard({ name: 'str_replace_editor', arguments: JSON.stringify({ command: 'create', path: '/work/x.md' }) }),
    /shape=scout/,
  )
})

test('CAPABILITY: a write command the guard cannot locate fails closed', () => {
  // The dangerous direction is a scope check that silently becomes a no-op when
  // upstream renames an argument. Unparseable means denied, not unchecked.
  const { guard } = guarded('fixer')
  assert.match(
    guard({ name: 'write', arguments: JSON.stringify({ file: '/work/anything' }) }),
    /carried no path this guard can read/,
  )
  assert.match(
    guard({ name: 'str_replace_editor', arguments: JSON.stringify({ command: 'create' }) }),
    /carried no path this guard can read/,
  )
  // A read-shaped call is not a write and stays free of scope checking.
  assert.equal(
    guard({ name: 'str_replace_editor', arguments: JSON.stringify({ command: 'view', path: '/work/NOTES.md' }) }),
    undefined,
  )
})

// ── 2. Capability: writeScopes is a boundary, not a substring hint ───────────

test('CAPABILITY: writeScopes resists traversal, prefix collisions and relative paths', () => {
  const { guard } = guarded('fixer')
  const deny = (filePath, why) => assert.match(
    guard({ name: 'write', arguments: JSON.stringify({ file_path: filePath }) }),
    /outside the write scopes/,
    why,
  )
  const allow = (filePath, why) => assert.equal(
    guard({ name: 'write', arguments: JSON.stringify({ file_path: filePath }) }),
    undefined,
    why,
  )

  // A relative scope is workspace-relative, so `/work/src/a.py` is inside `src/`
  // and `/work/other-src/a.py` is not.
  allow('/work/src/a.py', 'inside the scope')
  allow('/work/src/deep/nested/a.py', 'inside the scope, nested')
  allow('src/a.py', 'a relative path resolves against the session cwd')

  deny('/work/src/../secrets', 'traversal out of the scope')
  deny('/work/src/../../etc/passwd', 'traversal further out')
  deny('/work/other-src/a.py', 'a sibling whose name merely starts with the scope')
  deny('/work/src-not-really/a.py', 'a prefix collision: "src" is not "src/"')
  deny('/work/tests2/a.py', 'a prefix collision on the second scope')
})

test('CAPABILITY: a home-relative writeScope expands and still contains', () => {
  const { guard } = guarded('fixer', { fixer: { shape: 'ship', writeScopes: ['~/notes/'] } })
  assert.equal(
    guard({ name: 'write', arguments: JSON.stringify({ file_path: `${process.env.HOME}/notes/a.md` }) }),
    undefined,
  )
  assert.match(
    guard({ name: 'write', arguments: JSON.stringify({ file_path: `${process.env.HOME}/notes/../.ssh/authorized_keys` }) }),
    /outside the write scopes/,
  )
})

// ── 3. Termination: the Lead's own primitive must survive a tightened card ───

test('TERMINATION: a lead card with an allow list does not lock out quorum_wait', () => {
  // docs/verification.md:454 records this as a known self-destruct switch: the
  // guard gates non-write tools by the card allowlist, and `quorum_wait` is the
  // plugin's own tool, so tightening the lead card silently kills the one
  // primitive whose absence deadlocks the team.
  const h = harness()
  apply(h.ctx, { ...CONFIG, roles: { ...CONFIG.roles, lead: { shape: 'ship', writeScopes: [], allow: ['read', 'write'] } } })
  const lead = h.create('lead-1')
  const reviewer = h.create('child-1', { parentId: 'lead-1', parentAgent: lead, name: 'reviewer' })
  h.emit('agent/created', { agent: reviewer })
  const leadGuard = h.guards.find((g) => g.agent === lead).fn

  assert.equal(leadGuard({ name: 'quorum_wait' }), undefined, 'the plugin\'s own tool is not a gated capability')
  assert.match(leadGuard({ name: 'bash' }), /not granted the bash tool/, 'the allowlist still gates everything else')
})

// ── 4. Cost: the billed figure must be the one the runtime defines ───────────

test('COST: billed tokens include the disjoint cache terms', () => {
  // dsh-llm/lib/types/types.d.ts:153-158 — "Counts are DISJOINT: inputTokens is
  // uncached input only; cached input is reported separately as
  // cacheReadTokens/cacheWriteTokens (billed input = sum of the three)."
  // Measured on 449 real calls (docs/M1-usage-accounting.md): the disjoint sum
  // equals totalTokens on every single sample, while input+output is off by 96.9%.
  const h = harness()
  apply(h.ctx, CONFIG)
  const lead = h.create('lead-1')
  h.create('child-1', { parentId: 'lead-1', parentAgent: lead, name: 'reviewer' })
  h.emit('agent/created', { agent: lead })
  h.emit('agent/created', { agent: h.roster.get('lead-1')[0].agent })
  const leadGuard = h.guards.find((g) => g.agent === lead).fn

  // 2,000,000 max: soft 1,400,000 / hard 1,800,000. This call bills 1,500,000
  // under the disjoint sum (75% — past soft, short of hard), but only 100,000
  // (5%) if the cache term is dropped. So the assertion below discriminates:
  // with the correct formula the soft tier has already blocked the spawn.
  h.emit('session/event', lead.session, {
    type: 'assistant/message',
    data: { usage: { inputTokens: 50_000, outputTokens: 50_000, cacheReadTokens: 1_400_000, cacheWriteTokens: 0 } },
  })
  assert.match(leadGuard({ name: 'spawn_teammate' }), /cost budget reached 75/, 'cache reads are billed')
  assert.equal(leadGuard({ name: 'write', arguments: '{"file_path":"/work/a.py"}' }), undefined, 'soft tier still writes')
})

test('COST: an assist with no usage object bills nothing and is not an error', () => {
  const h = harness()
  apply(h.ctx, CONFIG)
  const lead = h.create('lead-1')
  h.create('child-1', { parentId: 'lead-1', parentAgent: lead, name: 'reviewer' })
  h.emit('agent/created', { agent: lead })
  h.emit('agent/created', { agent: h.roster.get('lead-1')[0].agent })
  const leadGuard = h.guards.find((g) => g.agent === lead).fn

  h.emit('session/event', lead.session, { type: 'assistant/message', data: { message: {} } })
  assert.equal(leadGuard({ name: 'spawn_teammate' }), undefined)
  assert.equal(leadGuard({ name: 'write', arguments: '{"file_path":"/work/a.py"}' }), undefined)
})

// ── 5. Configuration: a malformed row must not reach the session path ────────

test('CONFIG: a row missing roles fails at activation, not on session creation', () => {
  // `agent/created` dispatches in `serial` mode (dsh-agent runtime-types:227), so
  // a throw inside the listener lands on the session-creation path — the failure
  // mode D2 measured as "the session cannot be created at all".
  const h = harness()
  assert.throws(
    () => apply(h.ctx, { budget: { maxBilledTokens: 1000, softTier: 0.7, hardTier: 0.9 } }),
    /quorum: config\.roles must be an object/,
  )
})

test('CONFIG: a budget that cannot bound anything is refused', () => {
  const base = { roles: CONFIG.roles, defaultRole: CONFIG.defaultRole }
  const h = harness()
  assert.throws(() => apply(h.ctx, { ...base }), /config\.budget/)
  assert.throws(
    () => apply(h.ctx, { ...base, budget: { maxBilledTokens: 0, softTier: 0.7, hardTier: 0.9 } }),
    /config\.budget\.maxBilledTokens/,
  )
  assert.throws(
    () => apply(h.ctx, { ...base, budget: { maxBilledTokens: 1000, softTier: 0.9, hardTier: 0.2 } }),
    /softTier/,
  )
})

test('CONFIG: a default card that is not a card is refused, but an absent one is the safe default', () => {
  const h = harness()
  assert.throws(
    () => apply(h.ctx, { roles: CONFIG.roles, budget: CONFIG.budget, defaultRole: { shape: 'nonsense' } }),
    /quorum: config\.defaultRole\.shape/,
  )
  // No defaultRole means "unlisted teammates are scouts", the fail-closed
  // direction, so it stays legal.
  assert.doesNotThrow(() => apply(h.ctx, { roles: CONFIG.roles, budget: CONFIG.budget }))
})

test('CONFIG: a read-only card may not be granted a shell', () => {
  // `writeScopes` cannot bound a shell — the guard sees a command string, not a
  // target — so "scout, allow: [bash]" is a guarantee the card cannot keep.
  // Refusing it at activation is the difference between a documented limit and a
  // footgun that reads as if it were enforced.
  const h = harness()
  assert.throws(
    () => apply(h.ctx, {
      ...CONFIG,
      roles: { ...CONFIG.roles, reviewer: { shape: 'scout', allow: ['read', 'bash'] } },
    }),
    /shape=scout \(read-only\) but grants bash/,
  )
  // A ship card may have the shell: its scope limit is explicitly a heuristic,
  // and it is the shape that is *supposed* to be able to change things.
  assert.doesNotThrow(() => apply(h.ctx, {
    ...CONFIG,
    roles: { ...CONFIG.roles, fixer: { shape: 'ship', writeScopes: ['src/'], allow: ['read', 'bash'] } },
  }))
})
