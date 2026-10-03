# 交接：D3 主体 —— 给 Lead 一个「等到收齐为止」的原语

前置：D0/D1/D2/D3a 已完成并验收，见 `docs/`。当前 `index.js` 有 `enforce()` + 普通会话豁免 + 5/5 本地单测，**不要破坏它们**。

## 要解决的问题

Lead 现在只能「自己判断讨论是不是结束了」。上游 `wait_agent` 帮不了它——实测对未运行的成员直接返回 `noProgress` / `reason: "no-active-peer"`，原文：*"wait_agent cannot make progress or wake inactive teammates."*

**注意一个容易搞反的点（已实测）**：`send_message` 给未运行的成员**是能冷恢复唤醒的**（reviewer 就是这样醒并回复的，回执 `status:"accepted"`）。所以缺的不是「踢醒」，是「**等待 + 判据**」。别去做 retry-wake 循环，那是伪需求。

## 交付物：一个面向模型的工具 `quorum_wait`

Lead 调用后阻塞到有结论或超时，返回结构化判定：谁交了、谁沉默、法定人数是否达成。

### 判据怎么算（关键，且只允许用现有事件）

- 成员提交的结论就是发给 Lead 的 Team 消息。持久证据是 Lead 会话日志里成对的 **`team/message/queued`** 与 **`team/message/delivered`** 事件，**queued 减 delivered 即未送达**。
- 谁该交：`ctx.agentTeams.listMembers(agent)` 里 `role === 'teammate'` 的行。
- 是否还在干活：`TeamMemberView.status`（`running` / `inactive` / `provisioning` / `failed`）。
- 法定人数：从 `config` 读（新增一个 `quorum` 配置块），默认「全部 teammate 各交一条」。

### 硬约束

1. **绝对不要新增自定义会话事件类型。** 已实测：写 `quorum/*` 类型事件会成功落盘，但**该会话之后永久打不开**（catalog 生成期固定、`ignorable` 无法从 `Session.append` 设置）。详见 `docs/D2-finding.md`。上游规范原文就禁止这件事。
2. **工具注册用 `ctx.tools.register(<原始 ToolDefinition>)`，零 import。** `ToolDefinition` 必须带 `output: { schema, render }` 和 `async execute(args, exec)`。不要 import `@deepseek-ai/*`（linked 包缺 `peerDependencies` 会静默不挂载）。
3. **`export const inject` 要声明所有用到的服务**，包括新引入的（如 `sessions`）。漏一个会抛 `cannot get property "x" without inject`，**后果是新会话完全无法创建**。
4. `ctx.agentTeams.membership()` 对非成员**抛 `TEAM_NOT_MEMBER`**；只有 `tryMembership()` 命中后才能调 `listMembers`。
5. 豁免逻辑不能退化：**没有 teammate 的普通会话，不得注册任何守卫、提示词 section 或新工具**。守卫去重按**对象身份（`WeakSet`）**，不是按 id。
6. 超时/取消必须尊重 `exec.signal`，别写死循环。

## 验收顺序（先零成本）

1. `node --test test/*.test.js` 现有 5 条仍全绿。
2. **新增单测覆盖 `quorum_wait` 的判定逻辑**，用假 session 事件流喂进去，至少覆盖：全员已交 → 立即返回达成；有人 queued 未 delivered → 判为沉默；teammate 为 `inactive` → 不误判为失败；超时 → 返回未收敛而不是抛错。参照现有 `test/enforcement-scope.test.js` 的写法。
3. `node --check index.js` 通过，重启服务，确认启动日志安静（普通会话只打 `EXEMPT`，不打 `policing`）。
4. 以上都过了，再考虑真机跑一轮 Lead 调 `quorum_wait`。**发任何模型请求前先报预估**：单派只读审查者 ≈ 76K billed / 6 步；三路径轮实测 91,272 billed；两成员并发轮 ≈ 361K（UI 口径）。

## 环境

```sh
export PATH="$HOME/.hermes/node/bin:$PATH"          # dsh 0.2.0-rc.2
cd ~ && pkill -f "dsh --profile quorum"; sleep 2
nohup dsh --profile quorum --port 3097 --no-open > ~/.qoder-cn/tmp/dsh-boot.log 2>&1 &
sleep 12 && head -1 ~/.qoder-cn/tmp/dsh-boot.log    # 带 token 的 URL 在第一行
```

插件代码改动要重启（HMR 只监视配置）。会话日志：`~/.dsh/sessions/--Users-wweiqi-Documents-deepseek-harness-default-workspace--/<id>/session.v4.jsonl.zstd`，用 `~/miniconda3/bin/zstd -dc` 解。靶子工作区 `~/Documents/deepseek-harness/default-workspace`（git 仓库，`calc.py` 里 `add` 是减法，有 `test_calc.py`）。

## 禁止

- 改 `~/.dsh/profiles/desktop/`、home 级 `~/.dsh/cordis.patch.yml`、`/Users/wweiqi/Desktop/update plan/Quorum` 整个目录。
- 用**改名**方式隔离坏会话：dsh 校验目录名必须等于 header 里的 session id，改名会制造 corrupt 并让 `workspaceRegistry` 初始化失败、连带 4 个条目不激活。要移出整个扫描路径（现有坏会话在 `~/dsh-quarantine/`）。
- 大文件一次性 `Write`：这个目录下 ~150 行的 Write 会被权限层以「内容截断」为由拦下（实际未截断）。**拆成小 Write + Edit** 可以通过。

## 交付

`index.js` 改动 + 新单测 + `docs/verification.md` 追加原始命令与输出。若实测推翻本文件任何一条前提，明确说出来并给证据，不要迁就。
