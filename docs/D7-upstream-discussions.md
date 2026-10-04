# D7 附:可直接粘贴的 Discussions 正文

投递目标:`https://github.com/deepseek-ai/deepseek-harness/discussions`
（该仓库 `has_issues: false`、`has_discussions: true`，因此走 Discussions）

下面两篇是**正文**,不是草稿提纲。语言用英文,因为上游仓库与代码注释都是英文;每篇都能独立成立,可以分开投,也可以合并成一篇"两个下游扩展点缺口"。

写作口径的三条自我约束:

1. **每一条断言都带 `file:line` 或可执行命令**,没有"我觉得"。
2. **承认上游的既有理由**。第一条缺口的上游注释明确说了为什么不做事件名注册——我引用了它,因为我的诉求不是推翻它,而是指出**它已经设计的机制缺少一个写入口**。
3. **给出多条可选实现,并标出成本最低的那条**。维护者拒掉一个方案的门槛,比拒掉一个问题的门槛低得多。

---

## 篇一:Roles cannot know external session-event types are skippable, and the documented marker has no writer

**标题建议**：`Downstream plugins cannot mark their own session events \`ignorable\`, so the one documented compatibility mechanism is unreachable`

### Body

We maintain an out-of-repo dsh plugin (a bundle only — no runtime changes, no fork). To keep an audit trail of enforcement decisions we wanted to append our own session events. We found that path closed, and we agree with the reasoning. What we could not find is the supported alternative.

The relevant contract, from `@deepseek-ai/dsh-session/lib/types/known-event-types.js:7-20`:

> Every `SessionEventMap` member declared in this repository — the event vocabulary this build understands. The persistence read path refuses to interpret a log containing a type outside this set unless the event carries the envelope's `ignorable` marker … **Downstream (out-of-repo) plugin events are outside this list by construction. The persisted `SessionEvent.ignorable` marker is the compatibility mechanism; event-name registration was rejected because it does not classify omission safety and would make reads composition-dependent.**

That is a clear, well-argued design: the envelope carries the compatibility mechanism, and event-name registration is deliberately not offered. The problem is the write side. `SessionEvent.ignorable` is documented as the mechanism (`dsh-session/lib/types/types.d.ts:497-507`, inside the `SessionEvent` envelope at 489-512):

> Marks an event a reader may safely skip when it does not recognize `type`. Absent means required … A writer sets `true` only on purely informational records whose loss cannot affect reconstruction.

but no API can set it. `Session.append` (`dsh-session/lib/types/index.d.ts:246`):

```ts
append<T extends SessionEventType>(type: T, data: SessionEventMap[T],
  ...opts: T extends SurfaceEventType ? [opts: SurfaceIntent<T>] : []): SessionEvent<T>;
```

`opts` exists only for `SurfaceEventType`, and its shape is `SurfaceIntent` — `surfaceOp` plus `sourceEventSeqs` (`dsh-session/lib/types/types.d.ts:467-475`). For a non-surface type the variadic tuple is empty, so there is no parameter a writer could pass; and the envelope's non-surface branch explicitly closes the other two fields (`surfaceOp?: never; sourceEventSeqs?: never` at `types.d.ts:508-511`) without offering `ignorable`. Since `append` takes `(type, data, ...opts)` and nothing else, that exhausts the writer's inputs. We also checked `ctx.sessions` / `Session` for a lower-level append or a marker setter and did not find one.

We confirmed the consequence the hard way, on `dsh 0.2.0-rc.2`: appending a custom type is **accepted** and **persists**, and the session then becomes permanently unopenable —

```
failed to observe session "session-91e8cfca-…": contains event type
"quorum/binding" (seq 112) unknown to this harness and not marked ignorable;
refusing to interpret the log — it was likely written by a newer harness (gateway/internal)
```

reproducible across restarts, independent of whether the plugin is still installed. (We quarantined that session rather than deleting it.)

So the situation a downstream plugin faces is: the read path tells it to use `ignorable`; the type declares `ignorable`; the writer cannot set `ignorable`; and getting it wrong destroys the session rather than failing. We ended up designing our whole audit surface to consume only existing event types, which we can live with — but it means "plugins may add informational records" is, in practice, unavailable.

### What we'd ask for (any one of these)

1. **An explicit marker option on append** — e.g. an options object for non-surface types, or a dedicated method:

   ```ts
   session.appendIgnorable(type, data)   // sets ignorable: true on the envelope
   ```

   This matches the documented mechanism without reopening event-name registration.

2. **Or make the refusal survivable** — if an unrecognized type without the marker is read, give the reader a way to open the session with those events surfaced as skips, rather than refusing the whole log. That keeps "defaulting to required means a forgotten marker over-refuses" while turning the failure from permanent into recoverable.

3. **Or state the closure explicitly in the type docs** — a sentence on `append` saying the `ignorable` marker cannot be set by callers, and that downstream plugin events are therefore effectively unsupported. The prose in `known-event-types.js` currently reads as if the mechanism is available to plugin authors; that is what led us to spend a session on it.

We are not asking for event-name registration. We are pointing out that the mechanism chosen *instead of* it appears to lack a public writer.

---

## 篇二:A bundle cannot mark its own plugin row as required, so a missing companion bundle is a silent no-op

**标题建议**：`A bundle's own rows cannot be declared required: a missing companion bundle leaves the plugin pending with only a stderr warning`

### Body

Our bundle needs a service provided by another bundle (`agentTeams`, from `@deepseek-ai/dsh-experimental-agent-team-profile`). If a user installs ours without that one, we stay pending forever. Measured output on a fresh profile, `dsh 0.2.0-rc.2`:

```
dsh: warning: 1 entry did not activate
quorum (dsh-quorum): pending (waiting for service: agentTeams)
```

The application starts, the UI looks normal, and nothing else happens. For a plugin whose entire value proposition is *mechanism-level* enforcement — as opposed to asking the model nicely — that is the worst possible failure shape: the user believes they are being governed and is not.

We understand why an optional `inject`-style dependency is not fatal, and we are not asking every plugin to be able to abort startup. What we could not find is any way for a package to opt into that behavior for its own rows.

`@deepseek-ai/dsh-app-boot/lib/index.js:3830-3843`:

```js
/**
 * Entry ids whose presence defines a usable DSH application.
 * The list is global rather than profile metadata. Missing or disabled ids do
 * not affect startup; an enabled listed entry must activate. ...
 */
const requiredStartupEntryIds = new Set([
  "agent-loop", "webserver", "modules", "connection",
  "headless-runner", "acp", "sdk-jsonrpc-server"
]);
```

and `auditStartupEntries` (`dsh-app-boot/lib/index.js:4009-4019`) builds the `required` set only from that constant plus the bootstrap include, so every other inactive entry — including a bundle's own rows — degrades to a warning.

The two declaration surfaces that could carry this have no field for it:

- `DshBundleManifest` (`@deepseek-ai/dsh-package-manifest/lib/types/types.d.ts`):

  ```ts
  export interface DshBundleManifest {
    /** One patch file path, or an ordered list applied in sequence ... */
    patch: string | string[];
  }
  ```

- a patch row's fields are `id` / `name` / `config` / `disabled` / `inject` / `intercept` / `isolate`; there is no required semantics.

A plugin also cannot ask for this at runtime, because the case we need to handle is precisely the one where it never activates.

### What we'd ask for (any one of these)

1. **`dsh.bundle.required: true`** — the bundle's top-level plugin rows join the required set: missing, disabled, or pending ⇒ startup failure with a remedy, exactly like `webserver` does today.

2. **`required: true` on a patch row** — finer grained, and it would let a bundle mark only the row that matters.

3. **Cheapest useful step: let a package supply its own remedy text.** Today's diagnostic names the missing service but not the package that provides it. If the pending line could read `pending (waiting for service: agentTeams — provided by @deepseek-ai/dsh-experimental-agent-team-profile)`, or if a package could register a remedy string for its own activation failure, this class of failure would go from "unreadable" to "actionable" without changing startup policy at all.

We would take option 3 over nothing. Option 1 or 2 would let a bundle make an honest promise about itself.

---

## 附:第三点,想单独确认一下设计意图(不是诉求)

`engines.dsh` has a declared type — `DshEnginesManifest.dsh?: string` in `@deepseek-ai/dsh-package-manifest` — but we could not find a reader for it anywhere in the installed runtime. The compatibility gate that actually runs is `peerDependencies` on `@deepseek-ai/dsh*`, checked by `evaluatePluginCompatibility` (`dsh-app-boot/lib/index.js:276-325`), which the installer and the profile loader both call.

We therefore declare our range as `peerDependencies: { "@deepseek-ai/dsh": ">=0.2.0-rc.2 <0.3.0" }` and keep `engines.dsh` for tooling.

If `engines.dsh` is reserved for future enforcement, or if `peerDependencies` is the intended and only mechanism, a line in the manifest docs would save every plugin author one round of trial and error. We are not asking for enforcement — only to know which of the two fields is the contract.
