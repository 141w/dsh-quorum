// Regenerate `test/fixtures/theme-tokens.json` from an installed DSH runtime.
//
// Why this file exists: `test/client-half.test.js` refuses to style the panel with a
// theme token the theme does not define. The first version of that check used a
// hand-kept list, and the list drifted — it waved through eight tokens as "used by the
// host's own panels" without checking, and missed ones the theme does define. The
// authority is `dsh-client-ui-theme/lib/client.js`, which the Theme Inspect provider
// does not expose in full (it advertises a curated subset of 15 out of ~380).
//
// That file only exists in a machine with dsh installed, so CI cannot read it. This
// script freezes its token set into a JSON fixture the test can always read, and the
// test still compares against the live file whenever it IS present, so a runtime
// upgrade that renames a token shows up as a failure rather than as silent drift.
//
// Usage: node test/theme-tokens.mjs
//   DSH_THEME=/path/to/dsh-client-ui-theme/lib/client.js to override discovery.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'test/fixtures/theme-tokens.json')

const DEFAULT_THEME = join(
  homedir(), '.hermes/node/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai',
  'dsh-client-ui-theme/lib/client.js'
)
const source = process.env.DSH_THEME ?? DEFAULT_THEME

if (!existsSync(source)) {
  console.error(`no theme file at ${source}`)
  console.error('set DSH_THEME=<path to dsh-client-ui-theme/lib/client.js> and retry')
  process.exit(1)
}

// Match `--dsw-<name>:` — a definition, not a reference. The colon is what separates
// `--dsw-alias-label-primary:` from the many bare uses of the same name.
const names = [...new Set(
  (readFileSync(source, 'utf8').match(/--dsw-[a-z0-9-]+(?=:)/g) ?? []).map((t) => t.replace('--dsw-', ''))
)].sort()

// Keep tokens already recorded even if this runtime does not define them, so pointing
// the script at an older runtime cannot quietly shrink the guard.
const previous = existsSync(OUT) ? (JSON.parse(readFileSync(OUT, 'utf8')).tokens ?? []) : []
const merged = [...new Set([...names, ...previous])].sort()

writeFileSync(OUT, JSON.stringify({
  _comment: 'Theme token names defined by @deepseek-ai/dsh-client-ui-theme/lib/client.js. '
    + 'Regenerate with `node test/theme-tokens.mjs`. test/client-half.test.js cross-checks '
    + 'this snapshot against the live theme whenever an installed runtime is present.',
  count: merged.length,
  tokens: merged,
}, null, 2) + '\n')

console.log(`read ${names.length} tokens from ${source}`)
console.log(`wrote ${merged.length} (merged with ${previous.length} previously recorded) to ${OUT}`)
