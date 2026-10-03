// Reconstruction of the pre-D3b index.js (154 lines, as read at session start)
// driven through the exact assertions test 1 of enforcement-scope.test.js makes.
import assert from 'node:assert/strict'
import { apply } from './d3a-baseline.mjs'

const CONFIG = {
  roles: { lead: { shape: 'ship', writeScopes: [], maxMembers: 4 } },
  defaultRole: { shape: 'scout', allow: ['read'] },
  budget: { maxBilledTokens: 400000, softTier: 0.7, hardTier: 0.9 },
}

const guards = []
const sections = []
const lines = []
const listeners = []

const ctx = {
  logger: { info() {}, warn() {} },
  on(_type, fn) { listeners.push(fn) },
  agentTeams: {
    tryMembership: (agent) => ({ root: agent, id: agent.id, role: 'lead', name: 'lead' }),
    // A plain session: the Lead pseudo-row and nobody else.
    listMembers: () => [{ name: 'lead' }],
  },
}

const lead = { id: 'lead-1', subagent: false, session: { id: 'lead-1', cwd: '/work' } }
lead.ctx = {
  tools: { guard(fn) { guards.push(fn) }, register(tool) { throw new Error(`baseline must not register: ${tool.name}`) } },
  systemPrompt: { section(s) { sections.push(s) } },
}

const original = console.log
apply(ctx, CONFIG)
console.log = (...rest) => lines.push(rest.join(' '))
for (const fn of listeners) fn({ agent: lead })
console.log = original

console.log(JSON.stringify({ listeners: listeners.length, guards: guards.length, sections: sections.length, lines }, null, 1))
try {
  assert.deepEqual(lines.filter((l) => l.includes('[quorum]')), [])
  console.log('test-1 assertion: PASS')
} catch (error) {
  console.log(`test-1 assertion: FAIL -> ${error.message.split('\n')[0]}`)
}
