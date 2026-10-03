# 交接：把「普通会话豁免」从配置巧合改成代码保证

日期：2026-10-03　前置：D0/D1/D2 已完成，见 `docs/`

## 要解决的问题（一句话）

现在「安装本插件不改变普通会话行为」这个保证，实际来源是 **`lead` 卡片碰巧宽松**，不是代码跳过注册。任何人给 `lead` 卡加上 `writeScopes`，**全机所有普通会话会立刻一起被收紧**。要把这个属性写进代码。

## 实测依据（不要重新验证，直接采信）

装上游 `dsh-experimental-agent-team-profile` 之后，**`ctx.agentTeams.tryMembership(agent)` 对每一个 agent 都返回定义值**，包括一个全新、没有任何 teammate 的空会话——它返回 `{role: 'lead'}`。

证据：插件在 `agent/created` 里注册角色卡声明后打到 stdout，重启并打开一个空会话，输出：

```
[quorum] role card section registered for "lead" (ship)
```

**结论：「是不是 lead」不能当豁免条件。** 豁免条件必须是「这个团队有没有 teammate」。

## 目标行为

| 情形 | 期望 |
|---|---|
| 空会话 / 普通会话，从未 spawn 过 teammate | **完全不注册守卫、不注册提示词 section**，行为与未安装本插件时逐字节一致 |
| 某会话 spawn 出第一个 teammate | 该刻起 Lead 与成员**都**被按各自角色卡约束 |
| teammate 自己 | 按 `config.roles[name] ?? config.defaultRole` 约束 |

## 实现要点

当前 `index.js` 的守卫体和提示词声明**内联在 `ctx.on('agent/created')` 回调里**，所以「给 Lead 补注册」做不到。必须先提取：

1. 把守卫注册 + `systemPrompt.section` 注册抽成 `enforce(agent, roleKey, teamId)`，卡片取 `config.roles[roleKey] ?? config.defaultRole`。
2. `apply()` 作用域里加 `const policed = new Set()`（按 teamId 去重，Lead 只补注册一次）。
3. `agent/created` 回调改成：

```js
const team = ctx.agentTeams.tryMembership(agent)
if (!team) return
const teamId = team.id
sessionTeam.set(agent.session?.id, teamId)

if (team.role === 'lead') {
  // 没有 teammate 的团队 = 普通会话，不干预
  if (ctx.agentTeams.listMembers(agent).length <= 1) return
} else {
  // TeamMembership.root 就是 Lead 的 Agent 对象，可以在这里补注册
  if (!policed.has(teamId)) { policed.add(teamId); enforce(team.root, 'lead', teamId) }
}
policed.add(teamId)
enforce(agent, team.role === 'lead' ? 'lead' : team.name, teamId)
```

`team.root` 是活 Agent 对象（`TeamMembership` = `{root: Agent, id: TeamId, role, name}`）。**注意 `id` 才是可用的 key**——之前有人写 `team.teamId ?? team.root` 把对象塞进持久事件，导致 `non-JSON-serializable`。

## 验收（必须零成本）

1. `node --check index.js` 通过。
2. 重启服务，打开一个**全新空会话**：stdout **不得**出现任何 `[quorum] policing` 行。
3. 让 Lead spawn 一个 reviewer（这一步花 token，动手前先报预估；基线：单派一个只读审查者 ≈ 76K billed / 6 步）：stdout 应出现 `[quorum] policing "lead"` 与 `[quorum] policing "reviewer"` 各一次，且**不重复**。
4. reviewer 仍被机制级拦住写文件（`tool/result` 里 `isError: true` + 拒绝文本），证明提取重构没削弱强制。

## 环境

```sh
export PATH="$HOME/.hermes/node/bin:$PATH"     # dsh 0.2.0-rc.2
cd ~ && pkill -f "dsh --profile quorum"; sleep 2
nohup dsh --profile quorum --port 3097 --no-open > ~/.qoder-cn/tmp/dsh-boot.log 2>&1 &
sleep 12 && cat ~/.qoder-cn/tmp/dsh-boot.log   # 第二行是带 token 的 URL
```

插件代码改动要重启服务（HMR 只监视配置）。靶子工作区 `~/Documents/deepseek-harness/default-workspace`（git 仓库，`calc.py` 里 `add` 是减法）。

## 必须遵守的既有结论（都实测过，别重做也别推翻）

- `export const inject` 要声明所有用到的服务，漏了会抛并**让新会话完全创建不了**。
- **零 import**：不 import 任何 `@deepseek-ai/*`（linked 包缺 `peerDependencies` 会静默不挂载）。
- 强制点只有 `agent.ctx.tools.guard()`（单调）。`restrict()` 被接受但拦不住调用。
- 不要用 `tools.get()` 探测能力，它对可调用工具返回 `undefined`。
- **不要新增自定义会话事件类型**：catalog 生成期固定、`ignorable` 无法设置，写了会让会话永久打不开（详见 `docs/D2-finding.md`）。
- 计费口径 `billed = input + output`，故意与官方 UI（`Σ totalTokens ÷ 2`）不同。
- **不要用改名方式隔离坏会话**：dsh 校验目录名必须等于 header 里的 session id，改名会制造 corrupt 并让 `workspaceRegistry` 初始化失败、连带 4 个条目不激活。要移出整个扫描路径（现有坏会话在 `~/dsh-quarantine/`）。

## 禁止修改

`~/.dsh/profiles/desktop/`、`~/.dsh/cordis.patch.yml`（home 级，会影响桌面版）、`~/Desktop/update plan/Quorum` 整个目录。

## 交付

改后的 `index.js`、`docs/architecture.md` 里把「非团队 agent 返回 undefined 所以不注册」那段**错误陈述**改掉、`docs/verification.md` 追加第 2、3 步的原始输出。若实测推翻上面任何一条，明确说出来并给证据。
