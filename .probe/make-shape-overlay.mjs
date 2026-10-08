/**
 * Build a standalone `--patch` overlay that raises the billed-token budget far above
 * anything one round can reach, so the cost tiers stay silent during the shape-gate
 * live run.
 *
 * Why: the shipped default (2,000,000 / soft 0.7 / hard 0.9) would fire `hard` in the
 * middle of a two-member round, and the hard tier ALSO refuses writes. A live round that
 * crossed it could not tell "the team is still in scout" apart from "the budget ran out",
 * which would make the run prove nothing about the thing under test. Raising the budget
 * is not hiding a discipline — D8 already measured both tiers firing on a real team — it
 * is isolating the one axis this round is about.
 *
 * Written as an overlay file rather than by editing the profile's own `cordis.patch.yml`,
 * so the profile is left exactly as found.
 *
 * Usage: node .probe/make-shape-overlay.mjs <profile> <maxBilledTokens> <outFile>
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const DSH_ROOT = join(homedir(), '.hermes/node/lib/node_modules/@deepseek-ai/dsh')
const YAML = createRequire(import.meta.url)(join(DSH_ROOT, 'node_modules/yaml'))

const [profile, budgetArg, outFile] = process.argv.slice(2)
if (!profile || !budgetArg || !outFile) {
  console.error('usage: node .probe/make-shape-overlay.mjs <profile> <maxBilledTokens> <outFile>')
  process.exit(2)
}

// The authoritative config, as the loader actually resolves it — read from the runtime,
// not from a hand-copy of cordis.patch.yml, so the overlay cannot drift from the bundle.
const dumped = execFileSync('dsh', ['--profile', profile, '--dump-config'], {
  maxBuffer: 1 << 28,
  stdio: ['ignore', 'pipe', 'ignore'],
}).toString()

const findQuorum = (value) => {
  if (value === null || typeof value !== 'object') return null
  if (Array.isArray(value)) {
    const hit = value.find((entry) => entry && entry.id === 'quorum')
    if (hit) return hit
    for (const entry of value) {
      const nested = findQuorum(entry)
      if (nested) return nested
    }
    return null
  }
  for (const entry of Object.values(value)) {
    const nested = findQuorum(entry)
    if (nested) return nested
  }
  return null
}

const row = findQuorum(YAML.parse(dumped))
if (!row?.config) throw new Error('no quorum row with a config in --dump-config')

const config = structuredClone(row.config)
config.budget = { maxBilledTokens: Number(budgetArg), softTier: 0.7, hardTier: 0.9 }
// The axis under test, stated explicitly rather than left to the default, so the run
// cannot be dismissed as "it only worked because of an implicit value".
config.transition = { gateWritesOnQuorum: true }

const document = [{ id: 'quorum', name: 'dsh-quorum', config }]

const header = [
  '# Overlay for the shape-gate live run (docs/verification.md D12). Applied with',
  '# `dsh --profile <p> --patch .probe/shape-gate-live.yml …`, after the profile layer.',
  '#',
  `# The budget is raised to ${budgetArg} billed tokens on purpose: a two-member round`,
  '# would otherwise cross the hard tier, and the hard tier also refuses writes — which',
  '# would make "still in scout" and "out of budget" indistinguishable in the transcript.',
  '# Cost tiers themselves are already measured live (D8).',
  '',
].join('\n')

writeFileSync(outFile, header + YAML.stringify(document))
console.log(`wrote ${outFile}`)
console.log(`  entries: ${document.map((entry) => entry.id).join(', ')}`)
console.log(`  budget: ${YAML.stringify(config.budget).trim().replace(/\n/g, ' ')}`)
console.log(`  transition: ${YAML.stringify(config.transition).trim().replace(/\n/g, ' ')}`)
console.log(`  keys restated: ${Object.keys(config).join(', ')}  (patch replaces the whole config)`)
