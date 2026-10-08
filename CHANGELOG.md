# Changelog

Notable changes per release. This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While `dsh` itself is `0.2.x` (alpha/rc), a `0.x` version here means: minor bumps may change
behaviour or the role-card semantics, patch bumps do not. The compatible `dsh` range is declared
in `package.json` `peerDependencies` and enforced at install time.

## Unreleased

### Changed

- **The panel is titled 「智能体」/ "Agents", and its number now includes the Lead.** The
  title band used to restate which session you are in (`本会话：Team Lead` /
  `本会话：团队成员`) while the trigger counted teammates only, so a Lead + 2 members team
  read `Quorum 2`. Upstream's own client view prepends the Lead row
  (`dsh-experimental-agent-team/lib/invariant.js:427-440`,
  `{id: state.id, name: 'lead', role: 'lead', phase: 'active'}`) and the official panel
  counts `team.members.length`, so the two surfaces disagreed about the same team. Now the
  band names the list, the badge counts every row, and the Lead row carries the same phase
  dot as its teammates. **"Which session you are in" moved onto the row it describes**: the
  `本会话` mark sits on the row whose id is the session being viewed — the Lead's row in the
  Lead's conversation, this member's row inside a teammate's conversation — which is both
  correct in the teammate case (the old band marked the *Lead* row as current while you were
  reading a member) and where the eye is already scanning. The two unused dictionary entries
  are deleted rather than left to rot. The 角色卡 section label stays: the row names *are*
  the role-card keys the guard binds against (`config.roles[team.name]`), which is this
  panel's own content and not the official roster's.

### Fixed

- **The discipline no longer outlives the bundle that installed it.** `tools.guard()`,
  `tools.register()` and `systemPrompt.section()` each return their exact disposer
  (`dsh-tools/lib/types/index.d.ts:636,655`;
  `dsh-system-prompt/lib/types/index.d.ts:239`), and all three were being dropped on
  the floor. `references/practices.md:19` says an `agent.ctx` registration has *two*
  owners precisely because "unloading the plugin does not dispose `agent.ctx`
  registrations by itself" — so a disabled bundle went on refusing tool calls for every
  agent it had ever policed. Registrations are now armed inside `agent.ctx.effect()` and
  kept in a plugin-side `ctx.effect()` keyed by the Agent object, released on
  `agent/disposed` and on plugin unload, in the shape `dsh-schedule/lib/index.js:2658-2668`
  uses.
- **The ledgers are bounded, and each has a named end.** `spend` and `sessionTeam` grew
  for the whole life of the process. `sessionTeam` is dropped per session on
  `session/disposed`; the budget drops when the **Lead's own** session leaves the store —
  `TeamId` is that session id branded
  (`dsh-experimental-agent-team/lib/types/types.d.ts:6-12`) — and deliberately *not* when
  a member's does, because the tokens a member burned are what the surviving members are
  measured against. `policed` is gone: the Agent-keyed disposer map already expresses
  "armed exactly once", and it keys on object identity, which is what the guard's scope
  requires. An agent with no session id is no longer routed at all, since an `undefined`
  key is one no teardown can ever name. The consequence is written into
  `docs/architecture.md`: budget accounting is scoped to *process × session residency*, so
  reopening a team's Lead session restarts its budget — the scope a process restart
  already had, now reached explicitly instead of by never cleaning up.

### Added

- **A teammate row in the Quorum panel now opens that member's own session.** The panel
  could name the roles but gave no way into the work, so "what is this agent actually
  doing" had exactly one answer: the official Agent Teams panel. The projection cannot
  supply an activity view — its member schema is strict and carries only
  `{id, name, role, phase, error?}`, and a plain-JS plugin cannot register a new
  projection key (`docs/D7-upstream-gaps.md`) — so navigation is the honest answer.
  The row is a keyboard-reachable `role="button"` and opens the member's session
  through the durable direct-parent address, the same call the official panel makes.

### Fixed

- **That row was dead on arrival in a browser: every click hit "该成员的会话当前未加载".**
  The address was read from `sessions.binding(memberId)`, which is only defined for
  sessions this browser has already loaded — and spawning a teammate never loads the
  child session into the browser store, so the feature only ever worked in the structure
  harness, where the binding is a stub. The address is now constructed
  (`{parentSessionId, childSessionId, mode: "continuable"}`) and `retain()` loads the
  child session on demand — the official Agent Teams panel's own pattern. Two regression
  tests in `test/client-half.test.js` pin the constructed address and the
  never-loaded-session case. A human click-through in the browser is still outstanding:
  the only live evidence so far is the row rendering (2026-10-04 screenshot), which does
  not exercise the click.

### Changed

- **The panel was rebuilt for readability.** It was structurally correct but visually a
  flat grey list. Now: a framed popover (1px `border-l3` plus the host's elevation
  tokens) rather than an unframed block, a bolder title, uppercase micro-labels, a filled
  count badge on the trigger, a per-teammate phase dot (green active / grey provisioning
  / red failed), a chevron on the rows that navigate, a callout-styled refusal notice, and
  an explicit "no members yet" state instead of an empty section.

- **The theme-token check no longer trusts a hand-kept list.** The old list had drifted
  into approving eight tokens as "used by the host's own panels" without checking, while
  missing ones the theme does define. The authority is the Theme's definition file
  (`dsh-client-ui-theme/lib/client.js` — the Theme Inspect provider advertises only a
  curated subset, 15 of ~400), which ships only with an installed runtime. So its token
  set is frozen into `test/fixtures/theme-tokens.json` by `node test/theme-tokens.mjs`,
  and `test/client-half.test.js` checks two things: every token the panel uses is in that
  snapshot, and — whenever a runtime is present — the snapshot still contains everything
  the installed theme defines. Regenerate after a runtime upgrade.

### Verified

- **The cost tiers fired for the first time, and the budget turned out to be narrower
  than it reads.** With `maxBilledTokens` lowered to 60,000, one real run crossed soft and
  hard: soft refused `spawn_teammate` ("cost budget reached 612% ... conclude with the
  members you already have instead of adding another"), hard refused `write` ("this team
  is in report-only mode"), and the target file was never created. The same run billed
  **228,639 — 381% of the budget** — because the guard is checked per tool execution and
  cannot interrupt reasoning between tool calls. `maxBilledTokens` is therefore a
  tool-surface budget, not a spending ceiling; documented in `docs/verification.md` D8,
  `docs/architecture.md`, and the README.

### Changed

- **The evidence gate no longer widens when it cannot locate a member's report.** If the
  delivered message id matches no `send_message` result in the member's own log, the
  verdict is now `unverifiable` instead of scanning the whole log for any successful tool
  result. The old behaviour made a missing boundary the cheapest way to pass: work done
  *after* the report, or work belonging to an unrelated task, counted as evidence for it.
  This is the third instance of the same pattern in this project — leniency resolving an
  ambiguity into a pass — and it is the one the gate can least afford, because the whole
  point is that a report is anchored to work that preceded it. Deleting the lenient
  branch also removed a conditional that became unreachable, so the detail line no longer
  needs to flag a relaxed judgement.

### Fixed

- **Two theme tokens in the panel did not exist.** `--dsw-alias-state-warning-primary`
  and `--dsw-alias-state-danger-primary` appear in zero installed packages (the real
  names are `state-warn-primary` and `state-error-primary`), so the `color-mix()`
  backgrounds of the panel's status chips resolved to transparent. Verified against the
  running `Theme` token list and by counting references across the runtime's packages.
- **The publish smoke test broke on npm's own output.** `npm pack --json` runs
  `prepack`, and npm prints that script's `npm notice` lines on stdout, which landed
  after the closing brace and made the JSON unparseable. `--silent` now suppresses them,
  and both result shapes npm has shipped for this command (an array, and an object keyed
  by package name) are accepted instead of pinning a client version.

### Added (tests)

- `test/lifecycle.test.js`: 8 cases for the two-owner teardown contract — the agent's own
  scope unarms guard + tool + prompt section, `agent/disposed` runs the plugin-side
  disposer and drops the strong Agent reference, double disposal is a no-op, unloading the
  bundle unarms everything still registered, a disposed guard *stops denying* (the
  mechanism is really uninstalled, not merely hidden), a member's departure keeps the
  ledger while the Lead's drops it, a keyless session cannot spend a team's budget, and a
  fresh Lead object for the same id re-arms. They were run against `HEAD` first: **8/8
  red**.
- `test/fixtures/host-ctx.js`: the host stub the three `apply()` suites share, now built to
  the runtime's actual disposal semantics — every registration returns a disposer, and
  `effect(run, label)` runs the body immediately and treats its return as the finalizer
  (`cordis/lib/types/fiber.d.ts:145-157`). A stub whose `guard()` returns `undefined`
  cannot express the contract these cases test, so it would let a plugin that keeps no
  disposer pass its own suite.
- The two bespoke stubs in `evidence-gate.test.js` and `quorum-wait.test.js` now dispatch
  listeners **by event type**. With a flat list, `emit(agent)` also fed the new
  `agent/disposed` and `session/disposed` listeners, which tore down the very registration
  those cases count — a failure the stub had, not the plugin.

- `test/client-half.test.js`: 9 cases driving the browser half without a browser —
  module contract, service declaration, slot registration as an effect, the empty-state
  early return, openable vs. non-openable rows, the navigation target, the keyboard path,
  the refusal path, hook order across a late-arriving projection, and a refusal of any
  theme token the running Theme does not define.

## 0.2.0

This release changes behaviour and role-card semantics, so it is a minor bump rather than a patch:
billed-token figures are now ~32x larger for the same work, and a `scout` card that grants a shell is
now refused at activation. Read the two **Breaking** notes before upgrading a budget.

### Fixed

- **Cost accounting billed the wrong number.** `billedTokens` returned `input + output`, on the
  belief that `cacheReadTokens` was a double-counted subset of `inputTokens`. The runtime's token
  contract says the counts are disjoint, and measurement on 449 real calls settles it: the disjoint
  sum equals `totalTokens` on every sample, while the old figure is low by 96.9%. Cache reads are
  96.9% of all billed tokens.
- **`str_replace_editor` bypassed the write-scope guard.** It can create and rewrite files but was
  not in the write-tool set, so a `fixer` could write anywhere and a `scout` could write at all.
  Its read-shaped `view` command correctly stays out of scope checking.
- **`writeScopes` was a substring match, not a boundary.** `other-src/x` matched the scope `src/`,
  and `src/../secrets` escaped it entirely. It is now a resolved-path containment test, with
  relative scopes anchored to the session workspace and `~` anchored to HOME.
- **A write the guard cannot locate now fails closed.** Previously an unrecognized argument name
  would have skipped the scope check silently — the failure mode where the mechanism looks
  installed and is a no-op.
- **A malformed config could break session creation.** `agent/created` dispatches in `serial` mode,
  so a missing `roles` key threw a `TypeError` on the session-creation path. The mirror-image
  failure was silent: `budget: {}` left every threshold comparison `false`, so the budget stopped
  existing while the plugin reported itself healthy. `apply()` now validates the row first and
  fails with a `quorum:`-prefixed error naming the exact key.

### Breaking

- **Billed tokens now include the cache terms**, so the same work bills ~32x more. `maxBilledTokens`
  is recalibrated in the same change (400,000 → 2,000,000) against a measured real team round of
  1,359,602 (Lead + 2 members), which is 68% of the new budget. Changing only the formula would have
  made every existing budget fire at 1/32 of its intended point. See
  `docs/M1-usage-accounting.md`.
- **A `scout` card granting `bash`/`pwsh` is now refused at activation.** A shell can write any
  path, so such a card claimed a guarantee the mechanism cannot keep. On a `ship` card the shell
  remains a documented limit rather than an error.

### Added

- **`quorum_wait` is exempt from role-card allow lists** (`PLUGIN_TOOLS`). It was previously gated
  like any other tool, so adding an `allow` list to the `lead` card silently revoked the Lead's only
  termination primitive — the self-destruct switch recorded in `docs/verification.md`.
- `peerDependencies: {"@deepseek-ai/dsh": ">=0.2.0-rc.2 <0.3.0"}`. This is the only compatibility
  gate the runtime actually enforces (`engines.dsh` has no reader), so an incompatible `dsh` is now
  refused at install time with the `dsh plugin allow-version` remedy instead of failing silently.
- **CI** (`.github/workflows/ci.yml`): syntax gate, test suite and publish smoke test on Node 22.19
  (the declared floor) and 22.x, against a pinned DSH runtime.
- **Release workflow** (`.github/workflows/release.yml`): publishes on GitHub Release with npm
  trusted publishing (OIDC) and a signed provenance attestation, and refuses a tag that disagrees
  with `package.json`.
- `test/publish-smoke.mjs` (`npm run smoke`, `npm run smoke:install`): packs the package, composes a
  throwaway profile around the installed copy, and asserts the `# == dsh-quorum` bundle layer and the
  `id: quorum` row actually appear in `--dump-config`. This is the one failure mode no unit test can
  see: a package that installs cleanly and never activates.
- `test/capability-boundary.test.js`: 12 cases pinning the boundary holes above, written before the
  fix so they failed first.
- `.probe/cost-tier-check.mjs` and `docs/D6-cost-tier-live.md`: the measurement, the runnable check
  and the operator brief for the one discipline with no live evidence.
- `docs/M1-usage-accounting.md`: the raw measurement behind the billing change.

### Known limitations carried forward

- The cost tiers have still never fired on a live team. 0.2.0 makes that testable (the old formula
  put the threshold out of reach); `docs/D6-cost-tier-live.md` is the brief.
- `bash`/`pwsh` on a `ship` card can still write outside `writeScopes`, and the path check cannot
  see through a symlink. Neither is a regression; both are the boundary's real edge.
- The `spend`/`sessionTeam` maps still grow without bound, and `agent.ctx` registrations still have
  no disposer kept on the plugin's own effect.

## 0.1.0

First release. Capability, termination, evidence and cost disciplines, plus the conversation-header
panel. Installed from source or from a pinned git ref; not yet on npm.
