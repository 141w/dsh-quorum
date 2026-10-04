# 架构与运行时边界

## 目的

`dsh-quorum` 是给 DeepSeek Harness **Agent Teams** 加的一层纪律：把「谁能动什么」「什么时候算讨论结束」「这轮能花多少钱」从**提示词约定**变成**机制强制**。

## 它不是什么

- 不是第二套会话系统、不是第二个 agent 运行时、不是新的编排器。
- 不提供成员列表、任务看板、mailbox、任务 DAG、依赖门禁、乐观并发——**这些 dsh 已有，本插件一律复用，不重复实现**。
- 不启动第二个 HTTP 服务，不替换认证或审批判定。

会话、模型请求、工具执行、权限判定、Team roster、任务板的所有权仍然完全属于 dsh。

## 唯一的强制点：单调守卫

```
agent/created
  └─ agentTeams.tryMembership(agent) → {role, name, root, id}
       └─ role === 'lead' 且 listMembers(agent).length <= 1 → 不注册任何东西（普通会话原样放行）
            └─ 否则 enforce(agent, roleKey, teamId)
                 ├─ agent.ctx.tools.guard(exec => string | undefined)
                 │    ├─ 命中规则 → 返回拒绝理由（该理由作为工具错误回给模型）
                 │    └─ 未命中  → 返回 undefined，调用照常执行
                 └─ agent.ctx.systemPrompt.section(角色卡声明)
```

三条实测得出的硬结论：

1. **守卫只作用于注册时所在的那个 agent 作用域**，因此能按角色区分。
2. **守卫是单调的**：没有任何守卫能把别的守卫判定的「拒绝」翻成「允许」，监听器排序也无法绕过。这是「机制级」区别于「约定级」的技术定义。
3. **`restrict()` 不能作为强制手段**。实测：`restrict({deny:['write','edit']})` 被 API 接受，但守卫仍然观察到该成员成功发起了 `write` 调用。它只影响可见性/提示词组装，不阻断调用路径。
4. **不要用 `tools.get(name)` 探测能力**。实测全局视图与 agent 视图对 `read/bash/edit/write` 全部返回 `undefined`，而守卫证明这些工具全都可调用。只有守卫里的 `exec.name` 是地面真相。

## 作用范围：按「有没有 teammate」豁免，不是按「是不是 lead」

**这条曾经的表述是错的**，原文写着「`tryMembership(agent)` 对非团队 agent 返回 `undefined`，此时不注册任何守卫」。**实测和源码都否证了它**：装了 `dsh-experimental-agent-team-profile` 之后，`tryMembership` 对一个全新、从未 spawn 过 teammate 的空会话**照样返回 `{role: 'lead', root: self, id: TeamId(self)}`**。源码就是这条行为（只读参照 `dsh-experimental-agent-team/lib/index.js:397-427`）：只有当 agent 的 `parentSession` 指向一个活着的 Lead、且自己在 roster 里是 `active`/`provisioning` 时才返回 `teammate`；其余分支一律返回 lead。文档里那句「undefined for non-Team subagents and stale identities」指的是 provider 子 agent 与失效身份，**不含普通会话**。

所以「这个 agent 是不是 lead」**不能**当豁免条件——它恒为真。豁免条件必须是**这个团队有没有 teammate**：

- `listMembers()` 的实现（`lib/index.js:436-466`）**恒定把 Lead 伪行放在第 0 位**，因此 `length <= 1` 就是「从未 spawn 过任何人」的可靠信号；
- 命中即 `return`，**守卫和提示词 section 都不注册**，普通会话与未安装本插件时逐字节一致；
- 第一个 teammate 的 `agent/created` 里用 `TeamMembership.root`（活 Lead Agent 对象）**回头补注册 Lead**，因此 Lead 与成员同时受约束；
- 补注册按 `teamId` 去重（`policed`），多个成员不会把 Lead 重复约束；但去重键**不能用 agent.id**——守卫的作用域是 agent 对象，同一个 id 的新 Agent 实例必须重新注册（用 `WeakSet` 按对象身份去重）。

**为什么这件事必须是代码保证**：在此之前，「安装插件不改变普通会话」实际是靠 `lead` 卡的 `writeScopes: []`（= 不限路径）**碰巧宽松**得到的属性。任何人给 lead 卡写上路径，全机所有普通会话会一起被收紧——治理层把自己的正确性押在了一个配置值的默认情况上。现在这个属性写进了控制流，改配置改不掉。

## 能力边界的真实形状

守卫在**工具边界**上判定，所以"写"这件事必须逐个工具名枚举，不能靠"凡是写都拦"。

| 工具 | 能否写出 `writeScopes` 之外 | 机制 |
|---|---|---|
| `write` / `edit` | 不能 | 路径解析后做包含判定 |
| `str_replace_editor` | 不能 | 只在 `create` / `str_replace` / `insert` 三个命令上是写；`view` 是读，不进 scope 检查 |
| `multiedit` | 不能 | 当前运行时没有这个工具，防的是别的构建里有 |
| `bash` / `pwsh` | **能** | 守卫看到的是命令字符串，不是目标路径。它就是挡不住 |
| 插件自己的工具（`quorum_wait`） | 不适用 | 不是对工作区的动作，因此不受角色卡白名单管辖 |

`bash`/`pwsh` 这一行是机制的**真实边界**，不是待办：

- 对 `shape: ship` 的卡片，它是已知局限——这类角色本来就该能改东西，`writeScopes` 只防误操作；
- 对 `shape: scout` 的卡片，它是**自相矛盾**：卡片的全部主张是"这个角色不能改工作区"。因此激活时直接拒绝"scout 卡带 shell"，而不是留一行文档指望读的人记得（`index.js` 的 `checkCard`）。

### 路径判定是解析后的包含关系，不是子串

`withinScopes` 用 `resolve` + `relative` 做包含判定，两侧都相对会话 cwd 解析（`~` 对 HOME）。旧写法是 `abs.includes(scope)` 子串匹配，两个洞都在实测里确认过：`other-src/x` 会被 `src/` 接受，`src/../secrets` 也会（穿越只有在解析之后才看得见）。

仍然**不是安全边界**的残余部分：

1. **符号链接**：判定发生在字符串层面，`src/link -> /etc` 之后的写入点落在 scope 之外，本判定看不见。要做成安全边界必须 `realpath` 后再比较，而那要碰文件系统、要处理不存在的路径。
2. **`bash`/`pwsh`**（上表）。
3. 它防的是模型的手滑与越界，不防蓄意规避。

### 角色卡不能撤销强制机制本身

`quorum_wait` 是插件自己的工具，因此**不受 `card.allow` 管辖**（`PLUGIN_TOOLS`）。此前它受管辖，于是给 `lead` 卡加一个 `allow` 列表就会把 Lead 唯一的"等到收齐"原语拦掉，终止纪律静默失效——这正是 `docs/verification.md:454` 记下的那个自毁开关。同一原则的另一半是"汇报是权利不是特权"（`VOICE_TOOLS`）：**角色卡管的是角色能对工作区做什么，管不到本插件提供判定能力。**

## 配置校验：在激活期拒绝，不在会话路径上抛

`agent/created` 是 `serial` dispatch（`dsh-agent/lib/types/runtime-types.d.ts:227`），监听器里抛出的异常落在**会话创建路径**上——D2 实测过这个后果：新会话完全建不出来。因此 `apply()` 第一件事是 `validateConfig()`，把坏配置变成一条带 `quorum:` 前缀、指名到键的错误：

| 配置 | 旧行为 | 新行为 |
|---|---|---|
| 缺 `roles` | 在 `agent/created` 上抛 `TypeError` | 激活期拒绝，指名 `config.roles` |
| `budget: {}` | **静默**：比值为 `NaN`，所有阈值比较为 `false`，预算消失 | 激活期拒绝，指名 `maxBilledTokens` |
| `softTier > hardTier` | 静默：降级顺序倒置 | 激活期拒绝 |
| `defaultRole.shape: "nonsense"` | 静默：按 ship 放行（未命中 scout 分支） | 激活期拒绝 |
| scout 卡带 `bash` | 静默：卡片承诺了它保证不了的事 | 激活期拒绝 |
| 缺 `defaultRole` | 回退到 scout（fail-closed） | 不变，仍然是合法的 |

方向是一致的：**能放行的一侧保持沉默，能静默失效的一侧必须响亮。**

角色卡写在 `cordis.patch.yml` 的 config 里，因此：

## 角色卡来自配置行，不来自文件

角色卡写在 `cordis.patch.yml` 的 config 里，因此：

- 用户可以在自己 profile 的 `cordis.patch.yml` 里**整行覆盖**（patch 语义是替换整个 `config`，不是深合并，所以覆盖时必须重述全部键）。
- 不需要 YAML/JSON 加载器、不需要额外依赖、不需要文件系统权限。
- 配置随组合包分发，可被 `dsh --profile X --dump-config` 直接看到。

`writeScopes: []` 表示**不限路径**（Lead 用这个值）。空数组不是「禁止一切」，这一点在代码里必须显式表达，因为它是反直觉的那一侧。

注意：lead 卡的宽松**不再**是「普通会话不受影响」这条保证的承重结构——那个保证现在由 `agent/created` 里的豁免分支提供（见上一节）。给 lead 卡加 `writeScopes` 只会收紧**真团队里的 Lead**，不会波及普通会话。

## 计费口径

上游的 token 用量契约写在 `dsh-llm/lib/types/types.d.ts:153-158`：

> Counts are DISJOINT: `inputTokens` is uncached input only; cached input is reported separately as `cacheReadTokens`/`cacheWriteTokens` (billed input = sum of the three).

因此本插件的计费口径是 **`billed = input + output + cacheRead + cacheWrite`**，即 `totalTokens` 本身。

这条口径在 2026-10-04 被实测确认，不是从注释推断的（原始数据见 `docs/M1-usage-accounting.md`）：18 个会话、449 次 `assistant/message` 调用中，**这个求和与 `totalTokens` 在每一条样本上精确相等**，而早先采用的 `input + output` 口径在总量上**偏低 96.9%（32.6 倍）**，因为缓存读占了全部计费的 96.9%。

早先的写法（`input + output`，理由是"`cacheRead` 被 `totalTokens` 重复计入"）来自对旧版语义的推断，已被实测否证。它造成过一个复合故障：

1. 按旧口径，一个真实团队轮的计费数字小到几乎不可能触及阈值——"三档从未真机触发"有一部分是这个原因，不只是"没测到"。
2. 旧的默认阈值 400,000 是在旧口径下定的，对同一轮真实团队（新口径 1,359,602）只相当于 29%。也就是说这个阈值当时既"小到不可能触发"（旧口径下那一轮只有 448,173 的 89%）又"小到一旦口径修正就立刻触发"，两个方向都是错的。

因此默认值随口径一起重定为 `maxBilledTokens: 2000000`：一轮真实团队（Lead + 2 成员）实测 1,359,602，占该预算的 68%——一轮绰绰有余，第二轮或更大的团队会触及 soft 档。**这两个数字必须一起改，只改公式会让每个用户的预算瞬间变成原来的 1/32。**

`billedTokens` 只读 `inputTokens`/`outputTokens`/`cacheReadTokens`/`cacheWriteTokens` 四个字段；`prompt_tokens`/`completion_tokens` 是旧名回退，当前运行时不再写出（449/449 样本里为 0 次）。

## 失败模式：Cordis 是 fail-closed 的

两条实测踩到的硬坑，写成本插件的开发约束：

1. **访问未在 `inject` 声明的服务会抛错，且抛在会话创建路径上。** 报错 `cannot get property "agentTeams" without inject`，后果是**新会话完全无法创建**（前端表现为输入框「会话不可用」），不是静默降级。可选链无效——属性访问本身就抛。
2. **linked 安装的包 import 宿主包却不声明 `peerDependencies`**，会得到 `failed to import` + `warning: 1 entry did not activate`，插件静默不挂载，只在启动日志留一行警告。

因此本插件**不 import 任何 `@deepseek-ai/*`**：只用全局对象与 `ctx`。唯一的 import 是 Node 内建模块 `node:os` 与 `node:path`——它们是随运行时一起提供的，版本由 `engines.node` 声明，不存在与宿主包版本错配的问题。

## 会话日志对插件是只读的

审计天然想写成持久会话事件，但这条路在本机构建里被机制封死（实验与原始报错见 `verification.md` 纪律 D）：

| 环节 | 实测 |
|---|---|
| `session.append('quorum/binding', …)` | **接受**，不校验类型名 |
| 落盘 `session.v4.jsonl.zstd` | **成功**，`flush` 返回 `true` |
| 重新加载该会话 | **拒绝**：`contains event type "quorum/binding" … unknown to this harness and not marked ignorable; refusing to interpret the log` |
| 后果 | 该会话历史永久不可读；重启后照样复现，与插件当前代码无关 |

三条硬事实：

1. `KNOWN_SESSION_EVENT_TYPES` 是 58 个类型的**生成表**（`dsh-session/lib/types/known-event-types.js`，注释原文：「Downstream (out-of-repo) plugin events are outside this list by construction」）。上游 `agent-team` 那种 `session.append(type, data)` 写法用的是**第一方已注册类型**，不是插件可扩展点。
2. 唯一的兼容机制是信封上的 `ignorable: true`，而 live `Session.append(type, data, opts)` 的 opts 只有 `surfaceOp` / `sourceEventSeqs`——**没有任何入口能设置这个标记**。
3. 上游自带的插件开发规范 `references/practices.md:21` 已经直接禁止这种做法，理由与实测一致。

代价对比：自定义事件**不进模型上下文**（非 surface 类型不参与历史重建），所以它对 KV-cache 确实是零影响——被否决不是因为贵，而是因为它把「一条审计记录」换成「整个会话不可读」。这是本插件不能承受的失败模式：**审计的意义是让事实可查，而不是让会话变成一次性消耗品。**

`try/catch` 在这里救不了场：它能保证「写入失败绝不把纪律变成放行」，但无法撤销已经成功写入并落盘的那一行。

因此纪律层可写的持久载体只剩两类，都还没验证：派生自上游已有事件（`ctx.sessionProjections`，声明式 map key 与 wire schema 不确定性高，故意押后），或插件自有 storage（`~/.dsh/storages/` 那条路，交接文档已明确判为「不算数」）。**D2 的正确下一步是先决定载体，不是先写代码。**

## 证据门禁：什么才算一条「结论」

### 为什么必须有

`quorum_wait` 原本只数「有没有 delivered 的 teammate 消息」。一条**没跑过任何工具、纯编造**的汇报同样满足法定人数——那等于把「模型自报置信度」从提示词搬到 mailbox 上重新发生一遍。本产品的全部说服力建立在「结论锚定可验证证据」上，所以判定改成两个条件同时成立：

1. 成员发给 Lead 的消息**已 delivered**（必要，不充分）；
2. 它**自己**的会话日志里，在那条汇报之前存在至少一条**成功**且**非团队协议**的 `tool/result`。

只统计满足 2 的。`verifiedCount >= requires` 才叫达成。

### 判定口径

| 环节 | 口径 | 为什么是这一条 |
|---|---|---|
| 边界事件 | 成员自己日志里**承载该 `messageId` 的 `send_message` 结果**；多条已提交时取最晚一条 | 同会话内 `seq` 单调，不涉及跨会话时钟。交接原方案「以 Lead 侧 `delivered` 时间为界」实测恒真：`delivered` 比成员自己那条 `send_message` 结果**晚 12–14ms**（3/3 样本），编造汇报会把自己的发送当成证据。原始数字见 `verification.md` D4 第 1 节 |
| 消息与日志的关联 | `send_message` 的结果文本就是 `{"messageId":"team-message-…","status":"queued"}`，按 id 匹配 | 实测自 B 轮真实会话日志；`tool/result` 里没有名字可查，只有 `toolCallId` |
| 什么算证据 | 成功的 `tool/result`，且其配对 `tool/call` 的 `name` **不在**协议工具集合里 | 协议集合 = `send_message` / `present` / `list_agents` / `wait_agent` / `interrupt_agent` / `spawn_teammate` / `team_task_*` / `todo_write`。它们成功一次只证明成员说了话 |
| 失败调用 | `isError === true` 一律不算 | 被角色卡守卫拒掉的 `write`、`FS_STALE_VERSION` 的 `edit` 都在真实日志里出现并被正确排除 |
| 谁的证据 | 只读 `Session.ownEvents()` | fork 会继承父会话全部历史，祖先的 `read` 不是这个成员的工作。`snapshotEvents()` 会把祖先段一起给出来，所以不用它 |
| 读不到日志 | `ctx.sessions.get()` 返回 `undefined`、`ownEvents()` 抛错或返回非数组 → `unverifiable` | 不抛给 Lead，也**绝不**判成 verified。fail-closed 的一侧 |
| 找不到边界 | `messageId` 在成员日志里对不上任何 `send_message` 结果（发送中途被杀、或由别的会话代发）→ **`unverifiable`，不放宽** | 旧口径是「全量窗口内任意成功工具都算」，理由是边界缺失不该让成员永远无法自证。**2026-10-04 真机数据否证了它**：宽容分支在一次日志里确实含提交结果的运行中被触发，说明「找不到边界」可以来自日志与投递状态的不一致，而不是成员无辜。而且它是**最省力的通过路径**——汇报之后干的活、或另一个任务的成功工具，都会被算成证据。判定不得从这种不一致里得出 `verified` |

三种状态在 Lead 读到的文本里必须一眼可分：`reported+verified` / `reported-but-unverified` / `no message yet`（外加 `reported-but-unverifiable` 与 `queued, not delivered yet`）。

### 可达性是被测试的性质，不是假设

B1 那轮的教训（`allow` 漏 `send_message` → 成员永远交不出、系统静默死锁、12 条测试全绿）在这里同样成立：门禁本身就可能把法定人数变成不可达。所以两道保护：

- 通信工具永远不受白名单管辖（`VOICE_TOOLS`，已有单测）；
- `test/evidence-gate.test.js` 第 1 条 `REACHABILITY:` 走完整链路断言「跑过一次 `read` 再汇报的成员仍能达成法定人数」，并断言 `ctx.sessions.get` 真被调用过——门禁不能靠「没人去查」而通过。
- 默认角色卡（`reviewer` / `defaultRole`）的 `allow` 含 `read, read_image, grep, glob`，都是能产生证据的工具；**给成员写一张不含任何非协议工具的 `allow` 就是在判它死刑**，配置层没有机制拦得住，这条要背下来。

### 局限：这条门禁证明不了什么（必须明写）

**「跑过一次成功的工具」不等于「结论正确」。** 它只把「完全没动过手的编造」这一类挡在外面，剩下的都过不了：

1. **不检一致性**：成员可以 `read` 一个无关文件，然后编造结论。日志证明它动了工具，不证明它说的话与工具输出对得上。
2. **最小证据即可过关**：一条 `read` 就够，不需要它覆盖结论里的任何断言。
3. **间接执行算作证据**：`subagent` / `workflow` / `skill` 的结果由别的执行体产出，本口径下仍计为「这个成员动过手」。
4. **复述不可区分**：成员甲引用成员乙的 verified 结论汇报，日志上与它自己跑过一遍无法区分（法定人数仍要求它自己有证据，但「这条结论被独立验证过」是另一回事）。
5. **重启即失效**：成员会话不在本进程时读不到日志，历史 `verified` 退化为 `unverifiable`（实测 `live=false`）。这是 fail-closed，不是 bug，但 Lead 侧只有一行文本提醒。
6. **依赖 `@deprecated` 读面**：`ownEvents()` / `snapshotEvents()` 在上游头文件里标着「new calls are prohibited」。上游真删的那天，本门禁整体退化为 `unverifiable`（依旧不会放行，但会失去可用性），替代路径是引 `dsh-session-query` 的 SQLite 后端。

因此这条纪律的正确表述是：**没有工具痕迹的汇报不算数**，不是**有工具痕迹的汇报算数**。后者仍需要 Lead 自己核对内容与证据是否相称。

### 为什么仍然只读

审计的自然做法是把判定结果写回会话日志，这条路被机制封死（见上一节与 `D2-finding.md`）：写自定义 `type` 会让该会话永久打不开。所以证据门禁**只消费已有事件**，`index.js` 里没有任何 `append(`，插件也不注册新的事件类型。判定结果只活在 `quorum_wait` 的返回值与 Lead 的那一轮上下文里——不落盘、不可追溯，这是当前明确的代价。

## 已知限制

- **拒绝记录既不可见也不持久**：`ctx.logger` 在本机构建里不进 stdout、不进浏览器 console、不写会话日志（实测），而会话日志又不接受插件自定义事件类型（见上一节）。「可追溯」这条卖点目前没有机制级载体。
- **路径判定不是安全边界**：现在是解析后的包含关系（不再是子串），但仍然看不见符号链接，也挡不住 `bash`/`pwsh`。见「能力边界的真实形状」一节列出的三条残余。
- **`bash`/`pwsh` 在 `ship` 卡上是绕过路径**：机制的真实边界，不是待办。`scout` 卡带 shell 已在激活期拒绝。
- 预算按 teamId 聚合，依赖 `agent/created` 时建立的 session→team 映射；Lead 之外的成员若在其映射建立前就产生用量，会计入不到。teamId 取自 `TeamMembership.id`——**该类型没有 `teamId` 字段**，早先代码写的 `team.teamId ?? team.root` 实际拿到的是 Lead `Agent` 活对象（探针实测把它放进事件负载即抛 `non-JSON-serializable data`）。
- 预算的 `spend` / `sessionTeam` 两个 `Map` 只增不减，插件卸载时也不清理；`agent.ctx` 上的注册没有保留 disposer（上游 `practices.md:8,19` 要求两条都做）。对长进程是内存问题，对重载是行为问题，都还没修。
- 终止纪律：法定人数的**判定 + 等待 + 证据门禁**已实现（D3b、D4），**形状切换门禁未实现**。上游 `wait_agent` 唤不醒未运行的成员（实测 `noProgress` / `no-active-peer`），所以踢醒只能由 Lead 自己发 `send_message` 完成；实测 `send_message` 本来就能冷恢复成员，缺的从来不是踢醒机制。
- 证据门禁的强度上限见上一节「局限」六条。其中「重启后成员会话不常驻」已在真机复现（`live=false`）：重启会把历史 `verified` 全部退化成 `unverifiable`，Lead 侧只有一行返回文本提醒。
- **兼容性只在安装期拦得住**：本包用 `peerDependencies: {"@deepseek-ai/dsh": ">=0.2.0-rc.2 <0.3.0"}` 声明兼容范围，因为这是运行时**唯一**真正生效的闸门（`dsh-app-boot` 的 `evaluatePluginCompatibility` 只读 `peerDependencies`，`engines.dsh` 没有任何 reader）。代价是上游发布新的 rc 时用户会被拒绝安装并看到 `allow-version` 指令——这是刻意的：对 alpha 上游，响亮失败优于静默损坏。

