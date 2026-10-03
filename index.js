export const name = 'quorum'
export const inject = ['tools', 'agentTeams', 'systemPrompt', 'sessionProjections', 'sessions']

const WRITE_TOOLS = new Set(['write', 'edit', 'multiedit'])
const SPAWN_TOOL = 'spawn_teammate'
// Reporting is a right, not a privilege. An allowlist that gates these turns
// discipline into a silent deadlock: the member can never submit, the quorum can
// never be met, and nothing ever fails loudly.
const VOICE_TOOLS = new Set(['send_message', 'present'])
// A result from one of these proves only that the member talked to the Team. It
// can never stand as evidence that the member looked at anything.
const PROTOCOL_TOOLS = new Set([
  ...VOICE_TOOLS,
  'list_agents', 'wait_agent', 'interrupt_agent', 'spawn_teammate',
  'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update',
  'todo_write',
])
// Only this one carries a team-message id in its result, which is what makes a
// report locatable inside the reporter's own log.
const SUBMISSION_TOOL = 'send_message'
// Upstream's change-wait refuses anything under 10s, so shorter slivers of a
// deadline fall back to a plain timer instead of throwing TEAM_INVALID_TIMEOUT.
const MIN_CHANGE_WAIT_MS = 10000
const MAX_TOTAL_WAIT_MS = 600000

function parseArgs(raw) {
  if (raw === undefined || raw === null) return {}
  if (typeof raw === 'object') return raw
  try {
    return JSON.parse(raw) ?? {}
  } catch {
    return {}
  }
}

function targetPath(args) {
  return args.file_path ?? args.path ?? args.notebook_path
}

function withinScopes(cwd, filePath, scopes) {
  if (!scopes?.length) return true
  if (typeof filePath !== 'string') return false
  const abs = filePath.startsWith('/') ? filePath : `${cwd ?? ''}/${filePath}`
  const roots = scopes.filter((s) => !s.startsWith('~'))
  const home = scopes.filter((s) => s.startsWith('~')).map((s) => process.env.HOME + s.slice(1))
  return [...roots, ...home].some((scope) => abs.includes(scope.replace(/\/$/, '')))
}

/** totalTokens double-counts cacheRead; bill on the non-overlapping terms. */
function billedTokens(usage) {
  if (!usage || typeof usage !== 'object') return 0
  const input = Number(usage.inputTokens ?? usage.prompt_tokens ?? 0)
  const output = Number(usage.outputTokens ?? usage.completion_tokens ?? 0)
  return input + output
}

function findUsage(node, depth = 0) {
  if (depth > 5 || node === null || typeof node !== 'object') return 0
  let total = 0
  for (const [key, value] of Object.entries(node)) {
    if (key === 'usage' && value && typeof value === 'object') total += billedTokens(value)
    else if (value && typeof value === 'object') total += findUsage(value, depth + 1)
  }
  return total
}

function resultText(message) {
  const parts = message?.content
  if (typeof parts === 'string') return parts
  if (!Array.isArray(parts)) return ''
  return parts.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('\n')
}

/**
 * Decide whether a member's own log shows real work behind what it reported.
 *
 * The boundary is the member's LATEST `send_message` result carrying one of the
 * message ids the Lead saw delivered. A Lead-side stamp cannot serve as the
 * boundary: measured on the 2026-10-03 team logs, `queued` is written while the
 * sender is still executing and `delivered` follows it by 10-101ms, landing
 * 12-14ms *after* the reporter's own `send_message` result. Gating on "any
 * tool/result before delivered" would therefore be satisfied by the report itself.
 * @param input - the member's own events plus the ids it delivered to the Lead.
 * @returns `verified` or `unverified`, with the one line the Lead reads.
 */
export function judgeEvidence({ events, messageIds }) {
  const toolName = new Map()
  for (const event of events) {
    if (event?.type === 'tool/call' && event.data?.callId) toolName.set(event.data.callId, event.data.name)
  }

  let boundary
  const results = []
  for (const event of events) {
    if (event?.type !== 'tool/result') continue
    const name = toolName.get(event.data?.message?.toolCallId)
    if (name === SUBMISSION_TOOL && messageIds.some((id) => resultText(event.data?.message).includes(id))) {
      if (boundary === undefined || event.seq > boundary) boundary = event.seq
    }
    if (event.data?.message?.isError === true) results.push({ kind: 'failed', seq: event.seq })
    else if (name !== undefined && PROTOCOL_TOOLS.has(name)) results.push({ kind: 'protocol', seq: event.seq, name })
    else results.push({ kind: 'work', seq: event.seq, name: name ?? 'tool' })
  }

  const located = boundary !== undefined
  // An id found in no submission result means the report left no trace in this
  // log (killed mid-send, or sent by a different session). Everything is then
  // in-window rather than refusing the quorum outright, and the detail says so.
  const window = located ? results.filter((entry) => entry.seq < boundary) : results
  const work = window.filter((entry) => entry.kind === 'work')

  if (work.length) {
    return {
      status: 'verified',
      detail: `${work.length} successful tool result(s) before it reported; earliest: ${work[0].name} at seq ${work[0].seq}${located ? '' : ' (report not located in its log)'}`,
    }
  }

  if (!results.length) return { status: 'unverified', detail: 'no tool/result at all in its own session log' }
  const failed = window.filter((entry) => entry.kind === 'failed').length
  const protocol = window.filter((entry) => entry.kind === 'protocol').length
  const why = []
  if (failed) why.push(`${failed} failed`)
  if (protocol) why.push(`${protocol} protocol-only (${[...new Set(window.filter((e) => e.kind === 'protocol').map((e) => e.name))].join(', ')})`)
  if (results.some((entry) => entry.kind === 'work') && !work.length) why.push('work tools ran only after the report')
  return {
    status: 'unverified',
    detail: `${results.length} tool result(s) in its own log, none usable as evidence${located ? ` before seq ${boundary}` : ''}: ${why.join(', ') || 'nothing but the report itself'}`,
  }
}

/**
 * Answer the question the Lead cannot answer for itself: whose verdict has
 * actually reached this conversation. A submission only counts once a teammate's
 * message addressed to the Lead is recorded as *delivered* — `queued` without a
 * matching `delivered` means durable but unread, which is not a conclusion.
 *
 * Delivered is necessary, not sufficient: {@link judgeEvidence} then decides
 * whether the reporter has anything behind it. Only verified reports are counted
 * toward the quorum.
 * @param input - live roster rows, the Lead log's mailbox sets, and an evidence resolver.
 * @returns who reported, on what evidence, and whether the configured quorum is met.
 */
export function judgeQuorum({ roster, messages, delivered, leadId, requires, evidence }) {
  // Without a resolver the gate silently reopens, so an omitted one is fatal here
  // rather than lenient — a green suite must never mean "fabrication passes".
  if (typeof evidence !== 'function') {
    throw new Error('judgeQuorum requires an evidence(memberId, messageIds) resolver: a delivered message is not proof of work')
  }
  const deliveredIds = new Set(delivered)
  const members = roster
    .filter((row) => row.role === 'teammate')
    .map((row) => {
      const addressedToLead = messages.filter((m) => m.senderId === row.id && m.targetId === leadId)
      const landedIds = addressedToLead.filter((m) => deliveredIds.has(m.id)).map((m) => m.id)
      const verdict = landedIds.length ? evidence(row.id, landedIds) : { status: 'not-reported', detail: '' }
      return {
        name: row.name,
        // `inactive` is availability, never a failure verdict on the member's work.
        status: row.status,
        submitted: landedIds.length > 0,
        inFlight: addressedToLead.some((m) => !deliveredIds.has(m.id)),
        evidence: verdict.status,
        evidenceDetail: verdict.detail,
      }
    })
  const deliveredCount = members.filter((m) => m.submitted).length
  const verifiedCount = members.filter((m) => m.evidence === 'verified').length
  const wanted = Number(requires)
  const required = Number.isSafeInteger(wanted) ? wanted : members.length
  // A report that carries no evidence is just as outstanding as silence: the
  // member still owes a conclusion anchored in something it actually ran.
  const outstanding = members.filter((m) => m.evidence !== 'verified')
  // Not running means no future message can arrive on its own, so blocking until
  // the deadline would only spend the Lead's turn waiting for nothing.
  const stalled = outstanding.length > 0
    && outstanding.every((m) => m.status === 'inactive' || m.status === 'failed')
    ? { reason: 'no-active-member', message: `every member not counted toward the quorum (${outstanding.map((m) => m.name).join(', ')}) is inactive or failed` }
    : undefined
  return {
    quorumMet: verifiedCount >= required,
    required,
    deliveredCount,
    verifiedCount,
    members,
    ...(stalled ? { stalled } : {}),
  }
}

/**
 * Block until {@link judgeQuorum} converges, a stall makes further waiting futile,
 * or the deadline passes. Never throws for a timeout: a discussion that did not
 * converge is an answer, not an error.
 * @param deps - state reader, wake function, deadline, and an injectable clock.
 * @returns the final verdict plus how it ended.
 */
export async function waitForQuorum(deps) {
  const startedAt = deps.now()
  const deadline = startedAt + deps.timeoutMs
  let verdict = judgeQuorum(deps.read())
  let timedOut = false
  while (!verdict.quorumMet && !verdict.stalled) {
    const remaining = deadline - deps.now()
    if (remaining <= 0) {
      timedOut = true
      break
    }
    // A wake covers only changes that start after it is registered, so the state
    // is re-read on every return and each wait is capped to bound a missed edge.
    await deps.wait(Math.min(remaining, deps.pollMs))
    verdict = judgeQuorum(deps.read())
  }
  return { ...verdict, timedOut, waitedMs: Math.max(0, deps.now() - startedAt) }
}

/** Sleep that forwards caller cancellation, mirroring upstream's wait teardown. */
function nap(ms, signal) {
  return new Promise((resolve, reject) => {
    const finish = (settle) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      settle()
    }
    const onAbort = () => finish(() => reject(
      signal.reason instanceof Error ? signal.reason : new Error('quorum_wait aborted'),
    ))
    const timer = setTimeout(() => finish(resolve), ms)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
}

const intOr = (value, fallback) => (Number.isSafeInteger(Number(value)) ? Number(value) : fallback)

// Registration bypasses `defineTool`, so both schemas are already canonical
// JSON Schema: `required` is a name array, not the per-property flag the
// first-party `tool-agent-team` package writes before compiling.
const WAIT_PARAMETERS = {
  type: 'object',
  properties: {
    timeout_ms: {
      type: 'integer',
      description: `Total time to wait in milliseconds, from 0 through ${MAX_TOTAL_WAIT_MS}. Defaults to the configured quorum.timeoutMs.`,
    },
  },
}

const QUORUM_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    quorumMet: { type: 'boolean', description: 'Whether enough teammate reports are both delivered and backed by real tool evidence.' },
    timedOut: { type: 'boolean', description: 'True when the deadline passed with the quorum unmet.' },
    waitedMs: { type: 'integer', description: 'Milliseconds spent inside this call.' },
    required: { type: 'integer', description: 'Verified submissions the quorum needs.' },
    deliveredCount: { type: 'integer', description: 'Teammates with a delivered submission, verified or not.' },
    verifiedCount: { type: 'integer', description: 'Teammates whose submission is backed by a successful tool result that predates it.' },
    members: {
      type: 'array',
      description: 'One row per rostered teammate.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          status: { type: 'string', enum: ['running', 'inactive', 'provisioning', 'failed'] },
          submitted: { type: 'boolean', description: 'Delivered at least one message to the Lead.' },
          inFlight: { type: 'boolean', description: 'Has a queued message not yet delivered.' },
          evidence: {
            type: 'string',
            enum: ['verified', 'unverified', 'unverifiable', 'not-reported'],
            description: 'Whether its own session log shows a successful non-protocol tool result before it reported.',
          },
          evidenceDetail: { type: 'string', description: 'One line naming the evidence, or why there is none.' },
        },
        required: ['name', 'status', 'submitted', 'inFlight', 'evidence', 'evidenceDetail'],
      },
    },
    stalled: {
      type: 'object',
      description: 'Present when no outstanding member is running, so waiting longer cannot help.',
      additionalProperties: false,
      properties: {
        reason: { type: 'string' },
        message: { type: 'string' },
      },
      required: ['reason', 'message'],
    },
  },
  required: ['quorumMet', 'timedOut', 'waitedMs', 'required', 'deliveredCount', 'verifiedCount', 'members'],
}

const WAIT_DESCRIPTION = 'Block until the configured quorum of teammate reports has been delivered into this conversation AND backed by evidence, or until the deadline. Two conditions must both hold for a teammate to count: its message addressed to you is recorded as delivered (queued-but-undelivered does not count), and its own session log contains at least one successful tool result that predates that report. A report from a member that ran no tools at all is counted as reported-but-unverified and does not meet the quorum; send_message and the other team-protocol tools never count as evidence. Returns one row per teammate with availability, evidence verdict and a one-line reason, plus whether the quorum is met. This never wakes a silent member and never resends: when a member is outstanding or unverified, use send_message to start it and tell it to show the command output it is basing its claim on, then call quorum_wait again.'

const STATE = {
  verified: 'reported+verified',
  unverified: 'reported-but-unverified',
  unverifiable: 'reported-but-unverifiable',
}

function renderVerdict(value) {
  const ending = value.timedOut ? `timed out after ${value.waitedMs}ms` : `waited ${value.waitedMs}ms`
  return [
    `${value.quorumMet ? 'Quorum met' : 'Quorum NOT met'} — ${value.verifiedCount}/${value.required} teammate reports backed by tool evidence (${ending}); ${value.deliveredCount} delivered in total.`,
    ...value.members.map((m) => {
      const state = m.submitted
        ? STATE[m.evidence] ?? m.evidence
        : m.inFlight ? 'queued, not delivered yet' : 'no message yet'
      return `  - ${m.name} [${m.status}] ${state}${m.evidenceDetail ? ` — ${m.evidenceDetail}` : ''}`
    }),
    ...(value.stalled
      ? [`  ${value.stalled.message}. Wake one with send_message and require the tool output behind its claim, or conclude and name who never reported with evidence.`]
      : []),
    ...(value.members.some((m) => m.evidence === 'unverified' || m.evidence === 'unverifiable') && !value.stalled
      ? ['  An unverified member still owes evidence: ask it to run the command or read the file and report the output, then wait again.']
      : []),
  ].join('\n')
}

export function apply(ctx, config) {
  const spend = new Map()
  const sessionTeam = new Map()
  // Teams whose Lead is already policed, so a fan-out registers the Lead once.
  const policed = new Set()
  // Guards bind to an agent scope, so dedupe must key on the object, not the id:
  // a reused id with a fresh Agent object still needs its own guard.
  const guarded = new WeakSet()

  const deny = (reason) => {
    ctx.logger.info(`quorum: denied -> ${reason}`)
    return reason
  }

  /**
   * Ask a member's own session log what it actually did before it reported.
   * Read-only by construction: writing to another session is what made D2's
   * experiment unrecoverable (docs/D2-finding.md), and the log being audited is
   * the same log that would be corrupted. `ownEvents()` rather than the full
   * snapshot, because a fork inherits its ancestor's history and an ancestor's
   * `read` is not this member's evidence.
   */
  function resolveEvidence(memberId, messageIds) {
    const session = ctx.sessions.get(memberId)
    if (!session) {
      return { status: 'unverifiable', detail: `member session ${memberId} is not loaded in this process, so its log cannot be read` }
    }
    let events
    try {
      events = session.ownEvents()
    } catch (error) {
      return { status: 'unverifiable', detail: `reading its own events failed: ${error?.message ?? error}` }
    }
    if (!Array.isArray(events)) {
      return { status: 'unverifiable', detail: 'its session exposed no event list' }
    }
    return judgeEvidence({ events, messageIds })
  }

  /**
   * Hand the Lead one primitive `wait_agent` does not provide: a wait whose
   * stop condition is the durable mailbox rather than "something changed".
   * Registered on the Lead's own agent scope, so teammates never see it.
   */
  function armLeadWait(agent, teamId) {
    const cfg = config.quorum ?? {}
    agent.ctx.tools.register({
      name: 'quorum_wait',
      description: WAIT_DESCRIPTION,
      parameters: WAIT_PARAMETERS,
      output: {
        schema: QUORUM_VALUE_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: renderVerdict(value) }],
      },
      async execute(args, exec) {
        const timeoutMs = Math.min(Math.max(intOr(args?.timeout_ms ?? cfg.timeoutMs, 300000), 0), MAX_TOTAL_WAIT_MS)
        const pollMs = Math.max(intOr(cfg.pollMs, 30000), MIN_CHANGE_WAIT_MS)
        return await waitForQuorum({
          timeoutMs,
          pollMs,
          now: () => Date.now(),
          read: () => {
            const team = ctx.sessionProjections.stateOf(agent.session, 'agentTeam')
            return {
              roster: ctx.agentTeams.listMembers(agent),
              messages: team.messages,
              delivered: team.delivered,
              leadId: teamId,
              requires: cfg.requires,
              evidence: resolveEvidence,
            }
          },
          wait: (ms) => (ms >= MIN_CHANGE_WAIT_MS
            ? ctx.agentTeams.waitForChange(agent, ms, exec.signal).then(() => undefined)
            : nap(ms, exec.signal)),
        })
      },
    })
  }

  function enforce(agent, roleKey, teamId) {
    if (guarded.has(agent)) return
    guarded.add(agent)
    const card = config.roles[roleKey] ?? config.defaultRole
    const budgetRatio = () => spend.get(teamId) / config.budget.maxBilledTokens
    const isLead = roleKey === 'lead'

    agent.ctx.tools.guard((exec) => {
      const ratio = budgetRatio()

      if (exec.name === SPAWN_TOOL && isLead) {
        if (ratio >= config.budget.softTier) {
          return deny(`cost budget reached ${Math.round(ratio * 100)}% of ${config.budget.maxBilledTokens} billed tokens; conclude with the members you already have instead of adding another`)
        }
        const members = ctx.agentTeams.listMembers(agent).filter((m) => m.name !== 'lead')
        if (members.length >= (card.maxMembers ?? Infinity)) {
          return deny(`role card caps this team at ${card.maxMembers} members; finish an existing task before claiming another`)
        }
      }

      if (WRITE_TOOLS.has(exec.name) && ratio >= config.budget.hardTier) {
        return deny(`cost budget reached ${Math.round(ratio * 100)}%; this team is in report-only mode, summarise what you know and name what remains unverified`)
      }

      if (card.allow?.length && !card.allow.includes(exec.name) && !WRITE_TOOLS.has(exec.name) && !VOICE_TOOLS.has(exec.name)) {
        return deny(`role card "${roleKey}" is not granted the ${exec.name} tool`)
      }

      if (WRITE_TOOLS.has(exec.name)) {
        if (card.shape === 'scout') {
          return deny(`role card "${roleKey}" has shape=scout, which is read-only by construction; report your finding as a message to the lead instead of editing files`)
        }
        const path = targetPath(parseArgs(exec.arguments))
        if (!withinScopes(agent.session?.cwd ?? agent.session?.header?.cwd, path, card.writeScopes)) {
          return deny(`path ${path} is outside the write scopes [${card.writeScopes.join(', ')}] granted to role card "${roleKey}"`)
        }
      }
    })

    // Reaching here as Lead already implies a roster bigger than the pseudo-row,
    // because a team of one returns before enforce() is ever called.
    if (isLead) armLeadWait(agent, teamId)

    // Declare the card up front. Without this the only feedback channel is a
    // denial the model has to walk into first, so discipline stays reactive.
    // Registered on agent.ctx, so it can only ever widen this agent's prompt.
    try {
      agent.ctx.systemPrompt.section({
        name: 'quorum-role-card',
        order: 1000,
        interpolate: false,
        text: [
          `# Role card: ${roleKey}`,
          card.shape === 'scout'
            ? 'Shape: scout — read-only by construction. Deliver findings as messages; do not edit files.'
            : `Shape: ship — may write${card.writeScopes?.length ? ` only under: ${card.writeScopes.join(', ')}` : ' anywhere in the workspace'}.`,
          card.allow?.length ? `Granted tools: ${card.allow.join(', ')}. Other tools are denied.` : null,
          'A report counts only when backed by evidence: at least one successful tool result that is not send_message or another team-protocol tool must precede it, or the Lead\'s quorum_wait marks your conclusion unverified.',
          'These limits are enforced by a monotonic guard at the tool boundary. Retrying or routing around it will not change the outcome.',
        ].filter(Boolean).join('\n'),
      })
    } catch (error) {
      // A failed declaration must never take down session creation the way an
      // undeclared service injection did; enforcement still stands on its own.
      console.log(`[quorum] role-card section FAILED: ${error?.message ?? error}`)
      ctx.logger.warn(`quorum: role-card section failed: ${error?.message ?? error}`)
    }

    console.log(`[quorum] policing "${roleKey}" (${card.shape}) team=${teamId}`)
    ctx.logger.info(`quorum: bound role card "${roleKey}" (shape=${card.shape}) to a new agent`)
  }

  ctx.on('agent/created', ({ agent }) => {
    const team = ctx.agentTeams.tryMembership(agent)
    if (!team) return
    const teamId = team.id
    sessionTeam.set(agent.session?.id, teamId)

    if (team.role === 'lead') {
      // `tryMembership` resolves every non-teammate agent to `{role: 'lead', root: self}`,
      // so an ordinary session looks exactly like a team of one. `listMembers` always
      // prepends the Lead pseudo-row, therefore length <= 1 is the only signal that
      // nothing was ever spawned — and then the session must stay byte-for-byte untouched.
      if (ctx.agentTeams.listMembers(agent).length <= 1) {
        // The one thing that separates "exempted" from "the hook never fired",
        // so it stays reachable — but off by default, because every ordinary
        // session would print this line at boot.
        if (config.debug?.logExemption) {
          console.log(`[quorum] EXEMPT team-of-one session ${teamId}`)
        }
        return
      }
    } else if (!policed.has(teamId)) {
      // The Lead was created before any teammate existed, so it is bound here.
      // `TeamMembership.root` is the live Lead Agent; `id` is the only usable key.
      policed.add(teamId)
      enforce(team.root, 'lead', teamId)
    }
    policed.add(teamId)
    enforce(agent, team.role === 'lead' ? 'lead' : team.name, teamId)
  })

  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'assistant/message') return
    const teamId = sessionTeam.get(session?.id)
    if (!teamId) return
    const billed = findUsage(event.data)
    if (!billed) return
    const next = (spend.get(teamId) ?? 0) + billed
    const before = (spend.get(teamId) ?? 0) / config.budget.maxBilledTokens
    spend.set(teamId, next)
    if (before < config.budget.softTier && next / config.budget.maxBilledTokens >= config.budget.softTier) {
      ctx.logger.info(`quorum: team reached ${Math.round(next / config.budget.maxBilledTokens * 100)}% of its billed-token budget; new members are now blocked`)
    }
  })
}
