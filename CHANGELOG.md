# Changelog

Notable changes per release. This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While `dsh` itself is `0.2.x` (alpha/rc), a `0.x` version here means: minor bumps may change
behaviour or the role-card semantics, patch bumps do not. The compatible `dsh` range is declared
in `package.json` `peerDependencies` and enforced at install time.

## Unreleased

### Added

- **A teammate row in the Quorum panel now opens that member's own session.** The panel
  could name the roles but gave no way into the work, so "what is this agent actually
  doing" had exactly one answer: the official Agent Teams panel. The projection cannot
  supply an activity view — its member schema is strict and carries only
  `{id, name, role, phase, error?}`, and a plain-JS plugin cannot register a new
  projection key (`docs/D7-upstream-gaps.md`) — so navigation is the honest answer.
  The row is a keyboard-reachable `role="button"`; a member session that has been
  released reports that it cannot be opened rather than swallowing the click.

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
