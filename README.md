# dsh-quorum

[![ci](https://github.com/141w/dsh-quorum/actions/workflows/ci.yml/badge.svg)](https://github.com/141w/dsh-quorum/actions/workflows/ci.yml)

**Mechanism-enforced discipline for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Agent Teams.**

A team of coding agents usually fails in one of four ways: anyone can touch anything, nobody knows when the discussion is over, the bill arrives after the fact, and a confident report is treated as a verified one. Projects like [firstmate](https://github.com/kunchenguid/firstmate) solve these — but only by *asking* the model nicely, because a terminal harness gives them nowhere else to hook.

`dsh-quorum` enforces the same four disciplines **at the mechanism level**. A read-only reviewer does not *choose* not to edit files; it cannot.

> This is a plugin bundle, not a runtime. Sessions, model requests, tools, the agent loop, the roster, the mailbox, the task board and the Web UI all remain owned by dsh. This bundle only adds policy on top — and it reads durable facts that dsh already records.

## Install

Requires `dsh` in the range declared by `package.json` `peerDependencies` — currently `>=0.2.0-rc.2 <0.3.0`, verified against `0.2.0-rc.2`. That range is enforced at install time, because it is the only compatibility gate this runtime actually applies (`engines.dsh` is declared here for tooling but has no reader upstream). Installing on a `dsh` outside it is **refused** rather than silently allowed; to accept the risk anyway:

```sh
dsh plugin --profile <name> allow-version dsh-quorum@<version> --dsh-version <exact> --accept-risk
```

Three bundles have to land in one profile, in this order: the web app, the experimental Agent Teams profile, then this one.

```sh
dsh plugin --profile <name> add -w @deepseek-ai/dsh-web-app@0.2.0-rc.2
dsh plugin --profile <name> add -w @deepseek-ai/dsh-experimental-agent-team-profile@0.2.0-rc.2
dsh plugin --profile <name> add -w dsh-quorum@0.3.1
```

**Install it by name.** `dsh-quorum@0.3.1` went to the public registry on 2026-10-08, so `add -w dsh-quorum@<version>` resolves, and `latest` points at a real version. Note that dsh has no plugin marketplace regardless — the in-app form takes a package name, a GitHub repo or a local directory, and nothing searches npm for you. What makes a dsh plugin findable on npm is the keyword convention (`dsh`, `dsh-plugin`, `deepseek-harness`), which this package declares.

The first version could not be published by CI: npm attaches a trusted publisher to a package that already exists, so `0.3.1` went out from a maintainer machine (`npm login` with 2FA, then `npm publish --access public`), and releases after it go through `.github/workflows/release.yml`. Two consequences of that order, stated because both are checkable and neither is obvious:

- **`0.3.1` carries no signed provenance** — a maintainer-machine publish runs without `--provenance`, so `npm view dsh-quorum@0.3.1 attestations` returns *Not found* and `npm audit signatures` reports nothing for it. Its lineage is instead pinned by `gitHead = fc22584`, which is exactly the `v0.3.1` tag's commit. From the next CI release onward, attestations are published and this workaround is unnecessary.
- The registry record also contains a `0.0.0-stage` version, which is **npm's own placeholder**, created the moment the publish web-auth flow starts (`created 05:25:20`) and left behind when `0.3.1` landed 56 seconds later and moved `latest`. If `npm view` answers `0.0.0-stage`, you are inside that window — re-run, don't re-publish. `docs/verification.md` D14 has the raw timestamps.

**The first command is slow, and it is not stuck.** `@deepseek-ai/dsh-web-app` pulls close to 300 packages; measured on this machine it took 20 minutes with one automatic socket-timeout retry. The other two take seconds — installing `dsh-quorum` from npm measured 24.5s on a cold profile (D14), against 98s for the same package over `github:` (D11).

Pin a version if you care about what actually runs, either the npm version or the git revision. Upstream's own guidance is to lock the revision, because a later push to the default branch would otherwise change the code that executes at install time:

```sh
dsh plugin --profile <name> add -w 'github:141w/dsh-quorum#v0.3.1'
```

Measured for `v0.1.0` on 2026-10-04: resolves in 7.6s, records `github:141w/dsh-quorum#v0.1.0` in the profile, and `--dump-config` still shows the `# == dsh-quorum` layer. The same check for `v0.3.0` is recorded in `docs/verification.md` D11; `v0.3.1` supersedes it before anything reached npm, because D12 found a defect in that release (see the changelog).

Installing from a checkout works identically and is what the docs here were verified with:

```sh
dsh plugin --profile <name> add -w /path/to/dsh-quorum
```

**Four things will bite you if you skip them:**

1. **Always pin the version.** For the `@deepseek-ai/dsh-experimental-*` packages the `latest` dist-tag points at an **older line** (`0.1.5-alpha.2`), not at the `0.2.0-rc.2` that matches the runtime. Installing without a version gets you a bundle that silently does not load.
2. **Always pass `-w`.** A profile is a pnpm workspace whose root is the profile itself, so `pnpm add` refuses without `--workspace-root` (`ERR_PNPM_ADDING_TO_ROOT`).
3. **Agent Teams is not optional, and the failure is quiet.** This bundle injects the `agentTeams` service. Install it without the Agent Teams bundle and the plugin never activates — you get one warning line and nothing else:

   ```
   dsh: warning: 1 entry did not activate
   quorum (dsh-quorum): pending (waiting for service: agentTeams)
   ```

   Measured, not hypothetical: that is the exact output of installing `github:141w/dsh-quorum` into a fresh profile and starting it.

4. **Plugin rows come from bundle layers; your own `cordis.patch.yml` is for overriding rows that already exist.** `dsh plugin add` writes the bundle list and lets each bundle insert its own rows, and `scope` is a field of a *layer* rather than of a row — so hand-writing a fresh plugin row into the user layer is not a supported shape and, if it fails, it fails the same silent way as warning 3 (`1 entry did not activate`). What the user layer is for is an id-targeted override of an existing row, and that path is measured here rather than asserted: `docs/D6-cost-tier-live.md` lowered the budget with it and the cost tiers fired, and `- id: quorum` with `disabled: true` in the same file does turn the bundle's row off (`docs/verification.md` D15).
   ```yaml
   - id: quorum
     name: dsh-quorum
     config: { … }        # patch semantics replace the whole `config`; restate every key
   ```

   Installing with `dsh plugin add` never touches the user layer at all: it appends to `dsh.profile.bundles`, and this package's own row arrives through the bundle layer.

Verify without starting anything — the `# == dsh-quorum` comment is the layer's provenance:

```sh
dsh --profile <name> --dump-config | grep -A 12 "id: quorum"
```

Then start (`dsh --profile <name> --no-open` prints a token URL) and open the Plugins page — **智能体团队** and **dsh-quorum** should both be switched on.

A `github:` install runs no build step, so pnpm never asks you to authorise one: this package ships runnable source and declares no `prepare` script, deliberately. A TypeScript bundle that needs compiling would force every installer to add it under `allowBuilds` in the profile's `pnpm-workspace.yaml` first.

## What it enforces

| Discipline | Mechanism | Verification status |
|---|---|---|
| **Capability** — a role cannot do what it was not granted | Monotonic per-agent guard at the tool boundary; denials surface as `tool/result` with `isError: true` | ✅ live, three-path: scout denied writes, ship denied out-of-scope writes, lead allowed |
| **Termination** — a discussion is over when submissions arrive, and nothing is edited before it is | `quorum_wait`, a Lead-only tool that blocks on the durable mailbox (`team/message/queued` minus `delivered`), plus the shape gate: writes stay refused for every role until that wait reports the quorum met | `quorum_wait` ✅ live, both paths: `NOT met` with actionable guidance, and `met — 1/1`. Shape gate: ✅ **live both halves, 2026-10-08**: two rounds against the same seven-step task — the Lead's `write` refused verbatim before convergence (0/2, members named), then `Quorum met — 2/2` and the same write landed (`NOTES-LIVE.md`, 22 bytes, read back). See [docs/verification.md](docs/verification.md) D12/D13 |
| **Evidence** — a report counts only if it is anchored to a real tool run | Reads the member's own session log via `ctx.sessions.get()` | ✅ live: a teammate reported from pure common sense with **zero tool calls** in its log, and the gate refused to count it — verdict `0/1 … backed by tool evidence` |
| **Cost** — a budget, and graceful degradation when it is hit | Token accounting from `assistant/message` usage events; tiers stop new members, then stop writes | ✅ **triggered live 2026-10-04** (budget lowered to 60,000 to force it): soft refused `spawn_teammate`, hard refused `write`, and the target file was never written. ⚠️ It is a **tool-surface budget, not a spend cap** — the guard runs per tool execution, so the same run billed **228,639 (381% of the budget)**: reasoning steps between tool calls cannot be interrupted. See [docs/verification.md](docs/verification.md) D8 |

The header also carries one visible surface: a **Quorum** button beside the official team entry, listing the role cards bound to this Team, each member's phase, and the shared task board with its write-scope warnings. It renders nothing on a session without a Team.

Two design rules that are load-bearing and easy to break:

- **Reporting is a right, not a privilege.** `send_message` and `present` are exempt from `allow` lists. When they were not, a scout could never submit, the quorum was permanently unreachable, **and nothing failed loudly** — 12 green tests did not catch it. Only a live run did. The same rule now covers the plugin's own `quorum_wait`: a role card governs what a role may do *to the workspace*, and must not be able to revoke the mechanism that enforces the card.
- **Ordinary sessions are exempt by code, not by luck.** A session is policed only once it actually has a teammate. Otherwise editing the `lead` card would silently tighten every unrelated conversation on the machine.

## Configuration

Everything lives in the bundle's `cordis.patch.yml`, so a user can override it from their own profile patch without touching this package. Note that patch layers **replace the whole `config` of a row**, they do not deep-merge — override it by restating every key you need.

A malformed row is refused at activation with a `quorum:`-prefixed message naming the key at fault. That is deliberate: `agent/created` dispatches in `serial` mode, so a `TypeError` inside the listener lands on the session-creation path, and the opposite failure (`budget: {}`, which makes every threshold comparison `false`) used to leave the budget silently nonexistent.

```yaml
roles:
  lead:      { shape: ship, writeScopes: [], maxMembers: 4 }
  reviewer:  { shape: scout, allow: [read, read_image, grep, glob, list] }
  fixer:     { shape: ship, writeScopes: ["src/", "tests/"] }
defaultRole: { shape: scout, allow: [read, read_image, grep, glob, list] }
budget:      { maxBilledTokens: 2000000, softTier: 0.7, hardTier: 0.9 }
quorum:      { requires: all, timeoutMs: 300000, pollMs: 30000 }
transition:  { gateWritesOnQuorum: true }
debug:       { logExemption: false }
```

- A role is bound to a teammate's **durable Team name**, not to whatever the prompt says about it.
- `writeScopes: []` means *unrestricted*, not *forbidden*. A relative scope is workspace-relative.
- Unlisted teammates get `defaultRole`, which is `scout`: a role nobody declared is not implicitly trusted to modify the checkout.
- A `scout` card may not be granted `bash` or `pwsh` — a shell can write any path, so such a card would claim a guarantee the mechanism cannot keep. It is refused at activation.
- `pollMs` must stay ≥ 10000 — upstream's change-wait rejects shorter timeouts.
- **`transition.gateWritesOnQuorum` is the scout → ship switch, and it defaults to on.** While it is on, *every* role — the Lead included — is refused file writes until `quorum_wait` reports the quorum met: each required teammate delivered a message to the Lead **and** its own session log shows a successful non-protocol tool result before that report. Gating only the members would be no gate: the `lead` card above carries `writeScopes: []`, so an ungated Lead could just write the file itself. There is deliberately no `waiver` key and no evidence knob — `config.transition.waiver` is refused at activation rather than ignored, because a gate the agent can waive mid-round is a prompt convention, not a mechanism. Set it to `false` only to run a comparison round, and say so in the report.
- **Billed tokens are `input + output + cacheRead + cacheWrite`** — the runtime's own disjoint sum, which equals its `totalTokens`. Measured on 449 real calls; the cache terms are 96.9% of the total, so a budget set without them is off by orders of magnitude, not by a rounding error. See [docs/M1-usage-accounting.md](docs/M1-usage-accounting.md).
- **The budget bounds the tool surface, not the bill.** It is checked when a tool executes, which is the only point this plugin can refuse anything. Reasoning between two tool calls still bills, so a team that has crossed a tier keeps spending while it wraps up — measured at 3.8x the nominal budget (228,639 against 60,000). Set `maxBilledTokens` against the work you want done, not as a hard spending ceiling.

## Known limitations

Read these before trusting it. They are all measured, not hypothetical.

- **The header panel shows less than the plugin knows.** `client.js` registers one `conversation.session.header.actions` occupant: role cards bound to the durable roster, member phase, the task board and its `writeScopeWarnings`. It does **not** show quorum progress, evidence verdicts or budget tier, because the browser never receives them — the wire face of the `agentTeam` projection is `{members, tasks, failure}` and the mailbox stays server-side. Surfacing those needs a `dsh-api-*`-style remote service, which is the next piece of machinery, not a styling task.
- **The panel reports no member activity, so it navigates instead.** The projection's member schema is strict and carries exactly `{id, name, role, phase, error?}` — there is no current tool, output or progress on the wire, and a plain-JS plugin cannot register a new projection key (see [docs/D7-upstream-gaps.md](docs/D7-upstream-gaps.md)). Clicking a teammate row therefore opens **that member's own session**, which is where its work is actually visible. That is the same navigation the official Agent Teams panel performs, entered from the role card rather than the name. A member whose session has been released (it went inactive) cannot be opened; the panel says so instead of failing silently.
- **`quorum_wait` never wakes a silent member and never resends.** It waits on durable state only. If a member is inactive, the Lead must `send_message` it and call again — upstream's `wait_agent` explicitly refuses to wake inactive teammates, so this is not a gap we can close honestly.
- **`writeScopes` is now a resolved-path boundary, not a substring match** — traversal, prefix collisions and relative paths are all handled. It is still **not a security boundary**: it cannot see through a symlink, and `bash`/`pwsh` on a `ship` card can write anywhere (a `scout` card may not have a shell at all). A real boundary needs `realpath` comparison and would have to give up the shell entirely.
- **Overlapping `writeScopes` produce no warning.** Measured: `writeScopeWarnings` stayed `[]` throughout. What actually prevents lost work is a filesystem-level optimistic-concurrency guard (`FS_STALE_VERSION`), not the task board.
- **Budget attribution starts at `agent/created`.** Usage a member produces before its session→team mapping exists is not counted.
- **A `ship` card with a shell still writes anywhere, gate or no gate.** The shape gate bounds the tools that carry a path; `bash`/`pwsh` carry a command string, so a member holding a shell can write through it even while the team is in scout. This is the documented edge of the boundary, not something this release closes — the shipped cards grant shells only to `ship` roles. What the live rounds did show is about the *model*, not the mechanism: in D12 the Lead spent real turns probing for another way (`bash` with `command -v quorum_wait`, then three `wait_agent` calls) before it used `quorum_wait`, and in D13 it went straight to `quorum_wait` — but only because the task text said to. Do not claim discoverability is solved: a refusal the model never reads is a refusal that never taught anything.
- **With `quorum.requires: all`, one member that never reports keeps the whole team in scout.** D12 lived it: two members delivered, one of them was discounted as `unverifiable`, and the team could not write for the rest of the round. The verdict half of that is fixed (evidence is now judged while the log is open — D13 proves the same shape unlocking), and the policy half is deliberate: the denial names both exits (wake it with `send_message`, or conclude report-only) and points at `config.quorum.requires` as the only lever.
- **The gate reads the Team record from the Lead's session.** If that projection is not loaded in this process, writes stay refused and the denial says so — fail-closed by choice, which means a team whose Lead session was released mid-round cannot write even if it had converged.
- **A denied action is only visible if the model attempts it.** A Lead that never asks a scout to write produces no denial record at all.
- **Upstream is alpha.** `dsh` 0.2.x states plainly that breaking changes are coming. This bundle binds only documented seams and generated API surfaces.

## Development

No build step — the plugin is plain ESM and imports **no host packages**, because a linked package that imports `@deepseek-ai/*` without declaring `peerDependencies` fails to import *silently*. It imports only `node:os` and `node:path`, whose names are stable across the Node versions this package declares in `engines.node`.

```sh
npm run build                   # node --check index.js && node --check client.js
npm test                        # 48 tests
npm run smoke                   # pack + compose a profile + assert the bundle layer loads (offline)
npm run smoke:install           # the same, through a real `dsh plugin add <tarball>` (needs pnpm)
```

CI runs the first three on Node 22.19 (the declared floor) and 22.x, against a pinned `dsh` runtime — including the smoke test, because there is one failure no unit test can see: a package that installs cleanly and never activates, whose only trace is a single stderr line. `npm run smoke` packs the package, builds a throwaway profile around the installed copy, and asserts that `--dump-config` actually composes the `# == dsh-quorum` layer and the `id: quorum` row.

`client.js` is the browser half, declared through `dsh.client` in `package.json` and served as part of the combo bundle. It is plain `React.createElement` with no build step and no dependency beyond the `react` seed word, and it registers dictionaries via `ctx.locale` plus one slot occupant via `ctx.slots.inject`.

It is covered by `test/client-half.test.js`, which loads the file against a stubbed module loader and a stub React and drives the component's render path and its click/keyboard handlers. That harness exists because this half shipped for a day with two theme tokens that do not exist anywhere in the runtime — `--dsw-alias-state-warning-primary` and `--dsw-alias-state-danger-primary` — which made its status chips render with a transparent background. Nothing caught it, because nothing had ever executed this file. The harness cannot judge appearance; it can refuse an unknown token, a missing service, a broken registration, and a dead click path.

### Releasing

Publishing happens through `.github/workflows/release.yml` when a GitHub Release is published, using npm trusted publishing (OIDC) plus a signed provenance attestation — there is no npm token in the repository. **The first version has to be published by hand**, because trusted publishing needs the package to exist on the registry before a trusted publisher can be attached to it:

```sh
npm login                       # 2FA required
npm publish --access public     # publishes the first version
# then: npmjs.com → the package → Settings → Trusted Publisher → GitHub Actions
#   Organization or user: 141w     Repository: dsh-quorum     Workflow: release.yml
```

After that, cut a release: bump `version`, move the CHANGELOG entry out of the top section, tag `v<version>`, publish the GitHub Release. The workflow re-runs the full gate and refuses a tag that disagrees with `package.json`. To rehearse without publishing, run the workflow manually with `dry_run: true`.

Want to try it? **[docs/TESTING.md](docs/TESTING.md)** has six scenarios, each with the exact command to check the durable evidence rather than trusting the assistant's own report.

### Where the evidence lives

`docs/verification.md` records raw commands and raw output for every claim above, including the failures. Alongside it:

| Document | What it settled |
|---|---|
| [docs/D2-finding.md](docs/D2-finding.md) | Plugins **cannot** contribute durable session event types — writing one makes the session permanently unopenable |
| [docs/D3a-verified.md](docs/D3a-verified.md) | The ordinary-session exemption had to be a code path, not a config value |
| [docs/D5-live-verified.md](docs/D5-live-verified.md) | A tool armed mid-turn is invisible unless the model is told about it |
| [docs/M1-usage-accounting.md](docs/M1-usage-accounting.md) | Token accounting: the billed figure and the budget default, from 449 measured calls |
| [docs/D6-cost-tier-live.md](docs/D6-cost-tier-live.md) | The operator brief for the one discipline with no live evidence yet |
| [docs/D7-upstream-gaps.md](docs/D7-upstream-gaps.md) | The two upstream extension points this bundle needs and cannot build itself |

## License

MIT — see [LICENSE](LICENSE).
