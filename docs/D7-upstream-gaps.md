# D7：两条上游能力缺口（拟提交 upstream）

日期：2026-10-04　状态：**已核实、未提交**
上游仓库：`deepseek-ai/deepseek-harness`（`has_issues: false`、`has_discussions: true` → 走 Discussions）

这两条都是本插件在**只读**范围内无法自行解决的架构封闭。它们不是 bug：上游的实现有明确理由，两条理由我都在代码注释里读到了。缺口在于**下游插件没有任何等价路径**。

写作目的有两个：一是把它们交出去，二是让本插件"面板只显示这么多""缺依赖时只有一行警告"这两个限制，从"我没做完"变成"上游缺一个扩展点"——这两件事在对外叙述上不是一回事。

---

## 缺口 1：投影的 `wire` key 无法由下游插件注册

### 现象

插件想把 host 侧已经算出来的判定（法定人数进度、证据判决、预算档位）显示在会话头部的面板里。它**能**注册一个 host-only 投影单元并正确折叠状态，但那个状态**永远到不了浏览器**。

### 证据

`@deepseek-ai/dsh-session-projection/lib/types/index.d.ts:60-71` —— `wire` 只在 key 属于客户端投影表时才被允许：

```ts
/** Client view. Omit for host-only units. */
wire?: K extends keyof SessionProjectionMap ? { ... } : never;
```

两个 `register` 重载（同文件 150-159）：

```ts
register<K extends keyof SessionProjectionMap, S extends SessionProjectionStateMap[K]>(
  definition: Omit<ProjectionDefinition<K, S>, 'wire'> & { wire: NonNullable<...> }): () => void;

/** Register one host-only unit. Its state is omitted from client snapshots ... */
register<K extends Exclude<keyof SessionProjectionStateMap, keyof SessionProjectionMap>, S ...>(
  definition: Omit<ProjectionDefinition<K, S>, 'wire'>): () => void;
```

而 `SessionProjectionMap` 是**纯类型**的 merge-extensible 表（`dsh-session-projection/lib/types/types.d.ts:11-22`）：

```ts
/** The merge-extensible client projection table shared by wire blocks, client
 *  cells, and React hooks. Domain packages merge their client-visible key here ... */
export interface SessionProjectionMap {}
```

### 为什么下游无解

声明合并（declaration merging）是**编译期**的 TypeScript 特性。本插件是纯 ESM、零构建步骤、不 import 任何 host 包——它没有编译期。因此：

- 它只能走 host-only 那个重载 → 状态被明确排除在客户端快照外；
- 它没有任何运行时的 key 注册入口（`register` 不接受未声明的 key，`stateSchema` 也不构成注册）。

结果是：**一个零构建的下游插件，原理上无法把自己的派生状态送到自己的 UI 面板里。**

### 建议

任一即可：

1. 给 `register` 增加一个显式的运行时分支：允许传入 `key: string` + `wire: { viewSchema, view }`，由 runtime 在注册时维护 key 目录，而不是依赖类型表。类型表可以继续为首方提供编译期收窄。
2. 或者引入一个独立于 `SessionProjectionMap` 的"下游投影"注册面（例如 `ctx.sessionProjections.registerExternal({ key, stateSchema, wire })`），并明确它在客户端 store 中的位置（`projectionsBySession[id].values[key]`）。
3. 至少在 `SessionProjectionMap` 的文档里写明"下游插件无法扩展此表"，让这个限制可被发现——目前只能通过读重载的 `never` 分支推断出来。

### 影响面

不止本插件。任何"Host 算了、UI 想显示"的下游扩展都会撞到这面墙；绕过它的唯一办法是自建远程服务（`dsh-api-*` 那套），而那是把一个纯前端面板的需求升级成一套 RPC 面。

---

## 缺口 2：包无法声明"我这一行必须激活"

### 现象

本插件依赖 Agent Teams bundle 提供的 `agentTeams` 服务。如果用户漏装那个 bundle，插件**永久停在 pending**，进程照常启动、界面照常显示，只有一行 stderr：

```
dsh: warning: 1 entry did not activate
quorum (dsh-quorum): pending (waiting for service: agentTeams)
```

这是本插件实测到的真实输出（README 有原文）。对一个"机制级强制"的产品，这行警告是它最危险的失败模式：**用户以为装上就在被治理，其实什么都没发生。**

### 证据

`@deepseek-ai/dsh-app-boot/lib/index.js:3836`：

```js
/**
 * Entry ids whose presence defines a usable DSH application.
 * The list is global rather than profile metadata. ...
 */
const requiredStartupEntryIds = new Set([
  "agent-loop", "webserver", "modules", "connection",
  "headless-runner", "acp", "sdk-jsonrpc-server"
]);
```

`auditStartupEntries`（同文件 4009-4019）只对**这个硬编码集合**里的 id 抛 `StartupError`；其余一律降级为 warning。

而 `DshBundleManifest`（`dsh-package-manifest/lib/types/types.d.ts`）只有 `patch` 一个字段：

```ts
export interface DshBundleManifest {
  /** One patch file path, or an ordered list applied in sequence ... */
  patch: string | string[];
}
```

`cordis.patch.yml` 的行字段是 `id` / `name` / `config` / `disabled` / `inject` / `intercept` / `isolate`（见 `cordis-composition-reference` 技能文档），没有 required 语义。

### 为什么下游无解

插件**无法**把自己标记成 required，也无法让 `inject` 缺失变成硬失败。可选路径只有自建健康检查（在 UI 里显示一行"我没有激活"）——但那要求插件先激活才能显示，而它恰恰没激活。

### 建议

任一即可：

1. 允许包在 `package.json.dsh.bundle` 里声明 `"required": true`，让 Launcher 把该 bundle 的**顶层插件行**纳入 required 集合（缺失/禁用/pending 即启动失败并给出 remedy）。
2. 或者允许 patch 行声明 `required: true`，语义为"本行未激活则启动失败"。
3. 或者成本最低的一条：把 pending 的**原因**从服务名升级为可执行建议。目前 `pending (waiting for service: agentTeams)` 不会告诉用户"去装 `@deepseek-ai/dsh-experimental-agent-team-profile`"。哪怕只是让诊断文案能由包提供一句 remedy，也能把这类失败从"看不懂"变成"照做"。

### 影响面

所有"需要另一个 bundle 才激活"的下游插件。这个组合（实验性能力 bundle + 第三方插件）在上游自己的 `OPTIONAL_BUNDLES` 机制下是被鼓励的形态，因此这个缺口会反复出现。

---

## 附：一个次要但同源的观察

`engines.dsh` 在 `DshEnginesManifest` 里有声明（`dsh-package-manifest` 的 `DshManifest`/`DshEnginesManifest`），但**运行时没有任何 reader**。实际生效的兼容性闸门只有 `peerDependencies` 里 `@deepseek-ai/dsh*` 的 semver（`dsh-app-boot/lib/index.js:286-325` 的 `evaluatePluginCompatibility`）。

本插件因此改用 `peerDependencies: {"@deepseek-ai/dsh": ">=0.2.0-rc.2 <0.3.0"}` 来声明兼容范围（`engines.dsh` 仍保留供工具使用）。如果 `engines.dsh` 是**有意**留给未来、或是被弃用的字段，文档里说明一下会省掉每个插件作者一次实验。
