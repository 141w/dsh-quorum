// Publish smoke test: does an installed copy of THIS package actually become a
// bundle layer in a profile?
//
// The failure this exists for is documented and measured: a package can install
// cleanly, and still never activate — the only trace is one line on stderr
// (`dsh: warning: 1 entry did not activate`). Nothing in `node --check` or the
// unit suite touches the manifest → Node resolution → patch-composition chain,
// so this script pins it:
//
//   1. `npm pack` the package as npm would publish it, and assert the tarball
//      actually carries every file the runtime reads at install time.
//   2. Compose a throwaway profile that installs the package exactly the way a
//      user does (`dsh plugin add`, whose result is a `link:`/`file:` dependency
//      plus a `node_modules` entry), then read the composed tree back with
//      `dsh --profile <name> --dump-config`.
//   3. Assert the `# == dsh-quorum` layer and the `id: quorum` row are present,
//      and that the row is not disabled.
//
// Step 2 uses a symlinked `node_modules` entry instead of running pnpm, so the
// default run needs no network and no pnpm: it exercises the same resolution
// seam (`dsh.profile.bundles` name → installed package → `dsh.bundle.patch` →
// that patch's rows) that pnpm's install produces. `--install` runs the real
// `dsh plugin --profile <name> add <tarball>` route for release verification.
//
// Usage:
//   node test/publish-smoke.mjs              # offline, no network
//   node test/publish-smoke.mjs --install    # real pnpm install from the tarball
//   node test/publish-smoke.mjs --keep       # leave the profile dir for inspection
//
// Exit code 0 = the installed copy composes a quorum layer. Non-zero = it does not.
// Nothing outside the temp directory is written; the working tree is untouched.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = new Set(process.argv.slice(2))
const REAL_INSTALL = args.has('--install')
const KEEP = args.has('--keep')
// Explicit seam for callers that carry their own `dsh` without putting it on
// PATH — CI runs a pinned runtime through `npm exec` and passes the resolved
// binary here, so the version under test is stated rather than inherited.
const DSH = process.env.DSH_BIN ?? 'dsh'

/** Files the runtime reads from an installed copy, beyond the JS entry points. */
const REQUIRED_IN_TARBALL = ['package.json', 'index.js', 'client.js', 'cordis.patch.yml']

let failures = 0
const fail = (message) => {
  failures += 1
  console.error(`  FAIL  ${message}`)
}
const ok = (message) => console.log(`  ok    ${message}`)

/** Run a command, returning `{ code, stdout, stderr }` instead of throwing. */
function run(command, commandArgs, options = {}) {
  try {
    const stdout = execFileSync(command, commandArgs, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 1 << 28,
      ...options,
    })
    return { code: 0, stdout, stderr: '' }
  } catch (error) {
    return {
      code: typeof error.status === 'number' ? error.status : 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? String(error.message ?? error),
    }
  }
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const work = mkdtempSync(join(tmpdir(), 'dsh-quorum-smoke-'))
const dshHome = join(work, 'home')
const profile = 'smoke'
const profileDir = join(dshHome, 'profiles', profile)

console.log(`publish smoke: ${pkg.name}@${pkg.version}`)
console.log(`  package: ${ROOT}`)
console.log(`  workdir: ${work}`)
console.log(`  route:   ${REAL_INSTALL ? 'dsh plugin add <tarball> (pnpm)' : 'symlinked node_modules (offline)'}`)
console.log()

try {
  // ── 1. the tarball npm would publish ──────────────────────────────────────
  console.log('1. npm pack')
  const pack = run('npm', ['pack', '--json', '--pack-destination', work], {
    cwd: ROOT,
    env: { ...process.env, npm_config_cache: join(work, 'npm-cache') },
  })
  if (pack.code !== 0) {
    fail(`npm pack exited ${pack.code}: ${pack.stderr.trim().split('\n').slice(-3).join(' | ')}`)
    throw new Error('pack failed')
  }
  const packed = JSON.parse(pack.stdout.slice(pack.stdout.indexOf('[')))
  const tarballName = packed[0].filename
  const tarball = join(work, tarballName)
  ok(`packed ${tarballName} (${packed[0].entryCount} files, ${packed[0].size} bytes)`)

  const packedPaths = new Set(packed[0].files.map((file) => file.path))
  for (const required of REQUIRED_IN_TARBALL) {
    if (packedPaths.has(required)) ok(`tarball carries ${required}`)
    else fail(`tarball is missing ${required} — an installed copy cannot load`)
  }
  // `dsh.bundle.patch` must survive packing, or the profile layer resolves to nothing.
  if (!packedPaths.has(pkg.dsh.bundle.patch.replace(/^\.\//, ''))) {
    fail(`dsh.bundle.patch (${pkg.dsh.bundle.patch}) is not in the tarball`)
  }
  // The client half is resolved through the exports map; a package that declares
  // dsh.client without exporting ./client throws inside the Host at boot.
  if (pkg.dsh.client !== undefined) {
    if (pkg.exports['./client'] !== undefined) ok('exports ./client for the declared dsh.client half')
    else fail('declares dsh.client but exports no "./client" bundle')
  }
  console.log()

  // ── 2. compose a profile that installs it ─────────────────────────────────
  console.log(`2. profile "${profile}"${REAL_INSTALL ? ' via dsh plugin add' : ' (offline symlink)'}`)
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
  writeFileSync(join(profileDir, 'cordis.yml'), '[]\n')
  writeFileSync(join(profileDir, 'cordis.patch.yml'), '[]\n')
  writeFileSync(join(profileDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')

  const profileManifest = {
    name: `dsh-profile-${profile}`,
    private: true,
    dependencies: { [pkg.name]: `link:${ROOT}` },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', pkg.name] } },
  }
  writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify(profileManifest, null, 2)}\n`)

  if (REAL_INSTALL) {
    const add = run(DSH, ['plugin', '--profile', profile, 'add', '-w', tarball], {
      cwd: profileDir,
      env: { ...process.env, DSH_HOME: dshHome },
    })
    if (add.code === 0) ok('dsh plugin add exited 0')
    else fail(`dsh plugin add exited ${add.code}: ${(add.stderr || add.stdout).trim().split('\n').slice(-4).join(' | ')}`)
  } else {
    symlinkSync(ROOT, join(profileDir, 'node_modules', pkg.name), 'dir')
    ok(`linked node_modules/${pkg.name} -> the package root`)
  }
  console.log()

  // ── 3. read the composed tree back ────────────────────────────────────────
  console.log('3. dsh --profile smoke --dump-config')
  const dump = run(DSH, ['--profile', profile, '--dump-config'], {
    cwd: profileDir,
    env: { ...process.env, DSH_HOME: dshHome },
  })
  if (dump.code !== 0) {
    fail(`--dump-config exited ${dump.code}: ${dump.stderr.trim().split('\n').slice(-4).join(' | ')}`)
  } else {
    const tree = dump.stdout
    if (tree.includes('# == dsh-quorum')) ok('the "# == dsh-quorum" bundle layer is composed')
    else fail('no "# == dsh-quorum" layer: the bundle was not resolved from the installed package')

    const rowMatch = /^-\s+id:\s*quorum\s*$/m.test(tree)
    if (rowMatch) ok('the "id: quorum" row is present')
    else fail('no "id: quorum" row: cordis.patch.yml did not insert the plugin')

    // A row disabled by a higher-priority layer is composed but never mounted.
    const quorumBlock = tree.slice(tree.indexOf('id: quorum'))
    const disabled = /^\s+disabled:\s*true\s*$/m.test(quorumBlock.slice(0, 400))
    if (rowMatch && disabled) fail('the quorum row is disabled in the composed tree')
    else if (rowMatch) ok('the quorum row is not disabled')
  }
  console.log()
} catch (error) {
  if (failures === 0) fail(String(error?.message ?? error))
} finally {
  if (KEEP) console.log(`kept: ${work}`)
  else rmSync(work, { recursive: true, force: true })
}

if (failures > 0) {
  console.error(`publish smoke: ${failures} check(s) failed`)
  process.exit(1)
}
console.log('publish smoke: an installed copy composes a quorum bundle layer')
