export const name = 'quorum'
export const inject = ['tools', 'agentTeams', 'systemPrompt']

const WRITE_TOOLS = new Set(['write', 'edit', 'multiedit'])
const SPAWN_TOOL = 'spawn_teammate'

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

      if (card.allow?.length && !card.allow.includes(exec.name) && !WRITE_TOOLS.has(exec.name)) {
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
          'These limits are enforced by a monotonic guard at the tool boundary. Retrying or routing around it will not change the outcome.',
        ].filter(Boolean).join('\n'),
      })
    } catch (error) {
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
      if (ctx.agentTeams.listMembers(agent).length <= 1) {
        console.log(`[quorum] EXEMPT team-of-one session ${teamId}`)
        return
      }
    } else if (!policed.has(teamId)) {
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
