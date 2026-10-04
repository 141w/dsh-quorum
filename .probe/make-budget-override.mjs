/**
 * Rebuild a profile's cordis.patch.yml with the quorum row's budget lowered for the
 * D6 cost-tier live run.
 *
 * Why a script: the first attempt stringified the extracted `config` object and then
 * tried to re-indent it by hand, which produced `roles:` at the same level as `config:`
 * instead of under it. The plugin then received `undefined` config and refused to apply
 * with "quorum: config must be an object" — so the budget never policed anything and the
 * run proved nothing. Build the whole document with the YAML library instead of editing
 * indentation as text.
 *
 * Usage: node .probe/make-budget-override.mjs <profile> <maxBilledTokens>
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const DSH_ROOT = join(homedir(), '.hermes/node/lib/node_modules/@deepseek-ai/dsh')
const YAML = createRequire(import.meta.url)(join(DSH_ROOT, 'node_modules/yaml'))

const [profile, budgetArg] = process.argv.slice(2)
if (!profile || !budgetArg) {
  console.error('usage: node .probe/make-budget-override.mjs <profile> <maxBilledTokens>')
  process.exit(2)
}
const maxBilledTokens = Number(budgetArg)

const patchPath = join(homedir(), '.dsh/profiles', profile, 'cordis.patch.yml')

// The authoritative config for the quorum row, as the loader actually resolves it.
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

const config = row.config
config.budget = { maxBilledTokens, softTier: 0.7, hardTier: 0.9 }

// Keep every pre-existing entry of the patch file, drop any earlier quorum override, and
// append ours. `YAML.stringify` owns the indentation, so nothing depends on my spacing.
const existing = YAML.parse(readFileSync(patchPath, 'utf8')) ?? []
if (!Array.isArray(existing)) throw new Error(`${patchPath} is not a top-level array`)

const kept = existing.filter((entry) => entry?.id !== 'quorum')
const document = [...kept, { id: 'quorum', name: 'dsh-quorum', config }]

const header = [
  '# Your patch layer for this dsh profile, applied after every bundle layer.',
  '#',
  `# NOTE: the "quorum" entry below lowers the cost budget to ${maxBilledTokens} billed`,
  '# tokens so that one run crosses a tier and the degradation is observable. Restore',
  '# the default by deleting that entry (see docs/D6-cost-tier-live.md).',
  '',
].join('\n')

writeFileSync(patchPath, header + YAML.stringify(document))
console.log(`wrote ${patchPath}`)
console.log(`  entries: ${document.map((entry) => entry.id).join(', ')}`)
console.log(`  quorum budget: ${YAML.stringify(config.budget).trim().replace(/\n/g, ' ')}`)
