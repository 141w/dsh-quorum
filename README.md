# dsh-quorum

**Mechanism-enforced discipline for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Agent Teams.**

A team of coding agents usually fails in one of four ways: anyone can touch anything, nobody knows when the discussion is over, the bill arrives after the fact, and a confident report is treated as a verified one. Projects like [firstmate](https://github.com/kunchenguid/firstmate) solve these — but only by *asking* the model nicely, because a terminal harness gives them nowhere else to hook.

`dsh-quorum` enforces the same four disciplines **at the mechanism level**. A read-only reviewer does not *choose* not to edit files; it cannot.

> This is a plugin bundle, not a runtime. Sessions, model requests, tools, the agent loop, the roster, the mailbox, the task board and the Web UI all remain owned by dsh. This bundle only adds policy on top — and it reads durable facts that dsh already records.

## Install

Requires `dsh` 0.2.0-rc.2 or compatible. Three bundles have to land in one profile, in this order: the web app, the experimental Agent Teams profile, then this one.

```sh
dsh plugin --profile <name> add -w @deepseek-ai/dsh-web-app@0.2.0-rc.2
dsh plugin --profile <name> add -w @deepseek-ai/dsh-experimental-agent-team-profile@0.2.0-rc.2
dsh plugin --profile <name> add -w github:141w/dsh-quorum
```

`github:` is how you install it today. **The package is not published to npm yet**, so `add dsh-quorum` resolves to nothing, and no in-app search will find it either — dsh has no plugin marketplace, only a form that takes a package name, a GitHub repo or a local directory. What makes a dsh plugin findable on npm is the keyword convention (`dsh`, `dsh-plugin`, `deepseek-harness`), which this package declares for when it is published.

**The first command is slow, and it is not stuck.** `@deepseek-ai/dsh-web-app` pulls close to 300 packages; measured on this machine it took 20 minutes with one automatic socket-timeout retry. The other two take seconds.

Pin it if you care about what actually runs — upstream's own guidance is to lock the revision, because a later push to the default branch would otherwise change the code that executes at install time:

```sh
dsh plugin --profile <name> add -w 'github:141w/dsh-quorum#v0.1.0'
```

Verified: resolves in 7.6s, records `github:141w/dsh-quorum#v0.1.0` in the profile, and `--dump-config` still shows the `# == dsh-quorum` layer.

Installing from a checkout works identically and is what the docs here were verified with:

```sh
dsh plugin --profile <name> add -w /path/to/dsh-quorum
```

**Three things will bite you if you skip them:**

1. **Always pin the version.** For the `@deepseek-ai/dsh-experimental-*` packages the `latest` dist-tag points at an **older line** (`0.1.5-alpha.2`), not at the `0.2.0-rc.2` that matches the runtime. Installing without a version gets you a bundle that silently does not load.
2. **Always pass `-w`.** A profile is a pnpm workspace whose root is the profile itself, so `pnpm add` refuses without `--workspace-root` (`ERR_PNPM_ADDING_TO_ROOT`).
3. **Agent Teams is not optional, and the failure is quiet.** This bundle injects the `agentTeams` service. Install it without the Agent Teams bundle and the plugin never activates — you get one warning line and nothing else:

   ```
   dsh: warning: 1 entry did not activate
   quorum (dsh-quorum): pending (waiting for service: agentTeams)
   ```

   Measured, not hypothetical: that is the exact output of installing `github:141w/dsh-quorum` into a fresh profile and starting it.

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
| **Termination** — a discussion is over when submissions arrive | `quorum_wait`, a Lead-only tool that blocks on the durable mailbox (`team/message/queued` minus `delivered`) | ✅ live, both paths: `NOT met` with actionable guidance, and `met — 1/1` |
| **Evidence** — a report counts only if it is anchored to a real tool run | Reads the member's own session log via `ctx.sessions.get()` | ✅ live: a teammate reported from pure common sense with **zero tool calls** in its log, and the gate refused to count it — verdict `0/1 … backed by tool evidence` |
| **Cost** — a budget, and graceful degradation when it is hit | Token accounting from `assistant/message` usage events; tiers stop new members, then stop writes | ⚠️ **behaviourally unit-tested across all three tiers, never triggered live** (a live trigger would need ~280K tokens of real work) |

The header also carries one visible surface: a **Quorum** button beside the official team entry, listing the role cards bound to this Team, each member's phase, and the shared task board with its write-scope warnings. It renders nothing on a session without a Team.

Two design rules that are load-bearing and easy to break:

- **Reporting is a right, not a privilege.** `send_message` and `present` are exempt from `allow` lists. When they were not, a scout could never submit, the quorum was permanently unreachable, **and nothing failed loudly** — 12 green tests did not catch it. Only a live run did.
- **Ordinary sessions are exempt by code, not by luck.** A session is policed only once it actually has a teammate. Otherwise editing the `lead` card would silently tighten every unrelated conversation on the machine.

## Configuration

Everything lives in the bundle's `cordis.patch.yml`, so a user can override it from their own profile patch without touching this package. Note that patch layers **replace the whole `config` of a row**, they do not deep-merge — override it by restating every key you need.

```yaml
roles:
  lead:      { shape: ship, writeScopes: [], maxMembers: 4 }
  reviewer:  { shape: scout, allow: [read, read_image, grep, glob, list] }
  fixer:     { shape: ship, writeScopes: ["src/", "tests/"] }
defaultRole: { shape: scout, allow: [read, read_image, grep, glob, list] }
budget:      { maxBilledTokens: 400000, softTier: 0.7, hardTier: 0.9 }
quorum:      { requires: all, timeoutMs: 300000, pollMs: 30000 }
debug:       { logExemption: false }
```

- A role is bound to a teammate's **durable Team name**, not to whatever the prompt says about it.
- `writeScopes: []` means *unrestricted*, not *forbidden*.
- Unlisted teammates get `defaultRole`, which is `scout`: a role nobody declared is not implicitly trusted to modify the checkout.
- `pollMs` must stay ≥ 10000 — upstream's change-wait rejects shorter timeouts.
- **Billed tokens are `input + output`**, deliberately *not* the number the official UI shows. See the accounting note in [docs/architecture.md](docs/architecture.md).

## Known limitations

Read these before trusting it. They are all measured, not hypothetical.

- **The header panel shows less than the plugin knows.** `client.js` registers one `conversation.session.header.actions` occupant: role cards bound to the durable roster, member phase, the task board and its `writeScopeWarnings`. It does **not** show quorum progress, evidence verdicts or budget tier, because the browser never receives them — the wire face of the `agentTeam` projection is `{members, tasks, failure}` and the mailbox stays server-side. Surfacing those needs a `dsh-api-*`-style remote service, which is the next piece of machinery, not a styling task.
- **`quorum_wait` never wakes a silent member and never resends.** It waits on durable state only. If a member is inactive, the Lead must `send_message` it and call again — upstream's `wait_agent` explicitly refuses to wake inactive teammates, so this is not a gap we can close honestly.
- **`writeScopes` is a substring match.** `src/../secrets` walks out of it. It deters model mistakes; it is **not** a security boundary. A real one needs resolved-path comparison.
- **Overlapping `writeScopes` produce no warning.** Measured: `writeScopeWarnings` stayed `[]` throughout. What actually prevents lost work is a filesystem-level optimistic-concurrency guard (`FS_STALE_VERSION`), not the task board.
- **Budget attribution starts at `agent/created`.** Usage a member produces before its session→team mapping exists is not counted.
- **A denied action is only visible if the model attempts it.** A Lead that never asks a scout to write produces no denial record at all.
- **Upstream is alpha.** `dsh` 0.2.x states plainly that breaking changes are coming. This bundle binds only documented seams and generated API surfaces.

## Development

No build step — the plugin is plain ESM with **zero imports**, because a linked package that imports host packages without declaring `peerDependencies` fails to import *silently*.

```sh
npm run build                   # node --check index.js && node --check client.js
npm test                        # 27 tests
```

`client.js` is the browser half, declared through `dsh.client` in `package.json` and served as part of the combo bundle. It is plain `React.createElement` with no build step and no dependency beyond the `react` seed word, and it registers dictionaries via `ctx.locale` plus one slot occupant via `ctx.slots.inject`.

Want to try it? **[docs/TESTING.md](docs/TESTING.md)** has six scenarios, each with the exact command to check the durable evidence rather than trusting the assistant's own report.

`docs/verification.md` records raw commands and raw output for every claim above, including the failures. `docs/D2-finding.md`, `docs/D3a-verified.md` and `docs/D5-live-verified.md` document results that changed the design: plugins **cannot** contribute durable session event types (writing one makes the session permanently unopenable), the exemption had to be proven by positive evidence rather than by silence, and a tool armed mid-turn is invisible unless the model is told about it.

## License

MIT — see [LICENSE](LICENSE).
