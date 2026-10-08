import { memberLog, report } from './member-log.js'

// A stand-in for the host contexts that `apply()` uses, built to the semantics the
// installed runtime actually has — including the one thing that makes teardown
// testable: every registration returns its disposer.
//
// Why the disposer matters: `practices.md` Principle 2 says a registration made on
// `agent.ctx` has *two* owners — the agent's scope removes it when that agent is
// disposed, and the plugin's own effect removes it when the bundle unloads, because
// "unloading the plugin does not dispose `agent.ctx` registrations by itself"
// (references/practices.md:19). A stub whose `guard()` returns `undefined` cannot
// express that contract at all, so it would let a plugin that drops every disposer
// still pass its own tests.
//
// Signatures mirrored from the installed runtime, not invented:
//   tools.guard(fn)      dsh-tools/lib/types/index.d.ts:655   -> () => void
//   tools.register(def)  dsh-tools/lib/types/index.d.ts:636   -> () => void
//   systemPrompt.section dsh-system-prompt/lib/types/index.d.ts:239 -> () => void
//   ctx.effect(fn,label) cordis/lib/types/fiber.d.ts:145-157  -> Disposable, idempotent,
//                                                              body's return is the finalizer
//   agent/disposed       dsh-agent/lib/types/runtime-types.d.ts:240 payload {agent}
//   session/disposed     dsh-session/lib/types/index.d.ts:52    payload the session

/**
 * Register an effect body the way Cordis does: run it now, treat a returned
 * function as the finalizer, and hand back an idempotent disposer.
 * @param run - the effect body, exactly as passed to `ctx.effect`.
 * @param label - the diagnostic label the runtime would show in `getEffects()`.
 * @param log - where the teardown order is recorded.
 * @param registry - the list this effect is added to, so its owner can unload it.
 * @returns the disposer the owning context or test holds.
 */
function effect(run, label, log, registry) {
  const produced = run()
  const finalizer = typeof produced === 'function' ? produced : undefined
  if (finalizer === undefined && produced !== undefined) {
    // fiber.d.ts:151 — an effect body that returns an unusable shape is a error,
    // not something to swallow. Swallowing it here would hide a plugin that
    // "registers" teardown while nothing is ever torn down.
    throw new TypeError(`effect "${label}" returned ${String(produced)}`)
  }
  let done = false
  const dispose = () => {
    if (done) return
    done = true
    log.push(label)
    finalizer?.()
  }
  registry.push(dispose)
  return dispose
}

/** Remove one entry from an array, the way an upstream disposer unregisters. */
const drop = (list, entry) => () => {
  const at = list.indexOf(entry)
  if (at >= 0) list.splice(at, 1)
}

/**
 * Build an `effect` function with the semantics the real fiber has, for any stub
 * context that needs to hand out disposers.
 * @param log - where teardown labels are recorded, in the order they ran.
 * @param owner - prefix so several contexts can share one log.
 * @returns `{ effect, unload }`; `unload` tears that context's effects down in
 * reverse registration order, which is what Cordis does when the fiber unloads.
 */
export function makeEffect(log, owner) {
  const registry = []
  return {
    effect(run, label = 'anonymous') {
      return effect(run, `${owner}:${label}`, log, registry)
    },
    unload() {
      for (const dispose of registry.slice().reverse()) dispose()
    },
  }
}

/**
 * Build a host context plus the agent factory the disciplines are policed against.
 * @returns `{ ctx, create, emit, unload, ...}` and the registration lists to assert on.
 */
export function hostHarness() {
  const roster = new Map()
  const guards = []
  const sections = []
  const registrations = []
  const lines = []
  const injections = []
  const listeners = new Map()
  /** Labels of effects that have run their teardown, in the order they ran. */
  const disposed = []
  // Plugin-scope effects: torn down by `unload()`, in reverse registration order
  // exactly as fiber.d.ts:38 documents.
  const plugin = makeEffect(disposed, 'ctx')

  // The Team record the Lead's session projects: the mailbox the quorum and the shape
  // gate both read. It must be replaced by a NEW object whenever it changes, never
  // mutated in place — `stateOf` hands back a fresh reference exactly when an event was
  // folded (dsh-session-projection: `apply` returns the same reference for events it
  // ignores), and the gate memoises on that reference. An in-place mutation here would
  // let the gate serve a stale verdict forever, and the cases that depend on it would
  // pass for the wrong reason.
  let teamRecord = { messages: [], delivered: [] }

  /** Every member-session read the evidence gate performs, in order. */
  const evidenceReads = []
  /**
   * Members whose session has been released from the process: `sessions.get` answers
   * `undefined` for them, which is the exact D12 situation — the durable log still
   * holds the work, but nothing is readable right now.
   */
  const released = new Set()

  const rowsOf = (teamId) => (roster.get(teamId) ?? []).map((m) => ({
    id: m.agent.id,
    name: m.name,
    role: 'teammate',
    status: m.status,
    diagnostics: [],
  }))

  /** Every rostered teammate has delivered, with a real tool result behind it. */
  const converge = (teamId = 'lead-1') => {
    const messages = rowsOf(teamId).map((row) => ({
      id: `msg-${row.name}`,
      senderId: row.id,
      senderName: row.name,
      targetId: teamId,
      content: [],
    }))
    teamRecord = { messages, delivered: messages.map((m) => m.id) }
  }

  /** Nobody has delivered: the team is still in scout, so writes are held. */
  const lock = () => { teamRecord = { messages: [], delivered: [] } }

  /** The Lead session's projection is not in this process at all. */
  const unloadProjection = () => { teamRecord = undefined }

  const ctx = {
    logger: { info() {}, warn() {} },
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, [])
      listeners.get(type).push(fn)
    },
    effect: plugin.effect,
    sessionProjections: {
      stateOf: (_session, key) => (key === 'agentTeam' ? teamRecord : undefined),
    },
    // A member session whose own log shows exactly what the evidence gate asks for:
    // one successful non-protocol tool result, then the `send_message` result carrying
    // the id the Lead's mailbox lists as delivered. Shapes come from
    // fixtures/member-log.js, which is decoded from a real session log.
    sessions: {
      get(id) {
        if (released.has(id)) return undefined
        evidenceReads.push(id)
        for (const rows of roster.values()) {
          const hit = rows.find((m) => m.agent.id === id)
          if (!hit) continue
          const events = hit.evidenced === false
            ? []
            : memberLog([{ name: 'read', text: 'def add(a, b):\n    return a + b' }, report(`msg-${hit.name}`)])
          return { id, ownEvents: () => events }
        }
        return undefined
      },
    },
    agentTeams: {
      // Mirrors dsh-experimental-agent-team/lib/index.js:397-427 and 436-466: any
      // agent without a live roster entry resolves to {root: self, role: 'lead'},
      // and `listMembers` always prepends the Lead pseudo-row. The rows carry
      // `{id, name, role, status, diagnostics}` because `TeamMemberView` does
      // (lib/types/types.d.ts:42-52) — the quorum judge reads `role` and `status`.
      tryMembership(agent) {
        const member = (roster.get(agent.parentId) ?? []).find((m) => m.agent === agent)
        if (member) return { root: agent.parentAgent, id: agent.parentId, role: 'teammate', name: member.name }
        if (agent.subagent) return undefined
        return { root: agent, id: agent.id, role: 'lead', name: 'lead' }
      },
      listMembers(agent) {
        const teamId = agent.parentId ?? agent.id
        return [{ id: teamId, name: 'lead', role: 'lead', status: 'running', diagnostics: [] }, ...rowsOf(teamId)]
      },
      waitForChange: () => new Promise(() => {}),
    },
  }

  /**
   * Make one agent, optionally as a teammate of `parentId`.
   * @param id - the agent id, which is also its session id (agent.d.ts:14).
   * @param opts - `{parentId?, parentAgent?, name?, cwd?, noSession?, status?, evidenced?}`.
   */
  const create = (id, opts = {}) => {
    const agentScope = makeEffect(disposed, `agent(${id})`)
    const self = {
      id,
      parentId: opts.parentId,
      parentAgent: opts.parentAgent,
      subagent: false,
      // `noSession` is the shape an agent without a durable session takes; a routing
      // map keyed by `undefined` is a permanent entry no teardown can name.
      session: opts.noSession ? undefined : { id, cwd: opts.cwd ?? '/work' },
      inject(message) { injections.push({ agent: self, message }) },
      /** Tear the agent's own scope down, as AgentLoop does before `agent/disposed`. */
      dispose: agentScope.unload,
    }
    self.ctx = {
      effect: agentScope.effect,
      tools: {
        guard(fn) {
          const entry = { agent: self, fn }
          guards.push(entry)
          return drop(guards, entry)
        },
        register(tool) {
          const entry = { agent: self, tool }
          registrations.push(entry)
          return drop(registrations, entry)
        },
      },
      systemPrompt: {
        section(section) {
          const entry = { agent: self, ...section }
          sections.push(entry)
          return drop(sections, entry)
        },
      },
    }
    if (opts.parentId) {
      if (!roster.has(opts.parentId)) roster.set(opts.parentId, [])
      roster.get(opts.parentId).push({
        agent: self,
        name: opts.name,
        status: opts.status ?? 'running',
        evidenced: opts.evidenced !== false,
      })
    }
    return self
  }

  // Listeners take positional arguments (`session/event` is `(session, event)`),
  // so emit must forward them all rather than a single payload object.
  const emit = (type, ...args) => {
    const original = console.log
    console.log = (...rest) => lines.push(rest.join(' '))
    try {
      for (const fn of listeners.get(type) ?? []) fn(...args)
    } finally {
      console.log = original
    }
  }

  return {
    ctx,
    create,
    emit,
    /** Unload the plugin: every effect it owns, reverse order, as the fiber does. */
    unload: plugin.unload,
    guards,
    sections,
    registrations,
    lines,
    injections,
    roster,
    disposed,
    /** Make every rostered teammate delivered-with-evidence: writes unlock. */
    converge,
    /** Put the mailbox back to empty: the team is in scout again. */
    lock,
    /** Make the Team record unreadable, the way a session this process never loaded is. */
    unloadProjection,
    /** Release one member's session from the process, as going idle eventually does. */
    release: (id) => released.add(id),
    evidenceReads,
  }
}
