# 交接：给 dsh-quorum 实现「纪律审计落盘」（D2）

> 这份文档是给**新会话**的完整任务书。你不需要任何前置对话历史。

## 你的唯一工作目录（可写）

`/Users/wweiqi/Desktop/update plan/quorum-dsh-plugin`

这是一个独立的 dsh 插件仓库。**不要**碰 `/Users/wweiqi/Desktop/update plan/Quorum`（另一个已废弃的 Python 项目，有别的会话未提交改动）。除工作目录外，其余路径一律**只读**。

## 背景：这是什么产品

`dsh-quorum` 是给 DeepSeek Harness（`dsh`，github.com/deepseek-ai/deepseek-harness，本机版本 **0.2.0-rc.2**）的 **Agent Teams** 加的一层「纪律」插件。

核心论点：**上游 firstmate 项目用提示词约定实现的团队纪律，在 dsh 上可以用机制强制实现。** 插件只约束团队成员——`ctx.agentTeams.tryMembership(agent)` 返回 `undefined` 的普通会话必须完全不受影响。

## 当前状态（已完成并验收，别重做）

仓库里已有 `package.json`、`cordis.patch.yml`、`index.js`、`docs/architecture.md`、`docs/verification.md`。已用 `dsh plugin --profile quorum add -w <路径>` 装进 profile，挂载干净（无 import 失败、无未激活警告）。

**已实测通过的三路径验收**（判定依据是文件状态，不是模型自述）：

| 角色 | 角色卡 | 被要求 | 实测结果 |
|---|---|---|---|
| reviewer | `shape: scout` | 写 `review-result.md` | **拦住**，文件不存在 |
| fixer | `shape: ship`, `writeScopes: [src/,tests/]` | 追加根目录 `NOTES.md` | **拦住**，原文未变 |
| lead | `shape: ship`, `writeScopes: []`（=不限） | 改 `calc.py` 第 9 行 | **放行**，改动落盘 |

第三条是防误伤检查，缺了它这插件就是废的。

## 本次要做的唯一一件事：把拒绝记录变成持久事实

**问题**：现在每次拒绝只走 `ctx.logger.info`，而 dsh 的 logger 既不进 stdout 也不写会话日志。所以「谁在什么时候被哪条规则拦住」在 UI、会话回放、导出里**全都看不到**，只有扒文件系统才能证明发生过。这直接砸掉「可追溯」这个卖点。

**做法**：照上游 `agent-team` 自己的写法追加持久会话事件——`session.append(type, data)`。参照 `~/.hermes/node/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-experimental-agent-team/lib/index.js:157`，那里是 `root.session.append.bind(root.session)(type, data)`。

要写两类事件：

1. **`quorum/binding`** —— 在 `agent/created` 里绑定角色卡时写一条：
   `{version:1, role, shape, allow, writeScopes, teamId}`。
   这同时是本次验证的探针（因为它不需要模型调用就能触发）。
2. **`quorum/denial`** —— 每次守卫返回拒绝理由时写一条：
   `{version:1, role, tool, rule, ...}`。`rule` 固定取这六种：
   `scout-read-only` / `outside-write-scope` / `tool-not-granted` / `budget-soft` / `budget-hard` / `max-members`；
   涉及路径的带 `path`，涉及预算的带 `percent`。

**硬约束**：

- 追加必须包在 `try/catch` 里，失败只能降级成 `ctx.logger.warn`。**绝不能让审计写入把工具调用本身弄挂**——审计失败不能把「纪律失效」变成「放行」，也不能让会话崩掉。
- 追加目标用**发起方 agent 自己的 session**（`agent.session`），不要跨会话往 Lead 的日志里写。

## 已经踩过的坑，别再踩（全部实测得出）

1. **`export const inject = [...]` 必须声明所有用到的服务。** 访问未声明服务会抛 `cannot get property "xxx" without inject`，而且**抛在会话创建路径上，后果是新会话完全无法创建**（前端表现为输入框「会话不可用」）。可选链救不了——属性访问本身就抛。
2. **不要 import 任何 `@deepseek-ai/*`。** linked 包 import 宿主包却不声明 `peerDependencies`，会得到 `failed to import` + `warning: 1 entry did not activate`，插件**静默不挂载**，只在启动日志留一行警告。现有代码是零 import，请保持。
3. **`restrict()` 不能当强制手段。** 实测 `restrict({deny:['write','edit']})` 被 API 接受但拦不住调用，守卫仍观察到该成员成功发起了 `write`。唯一可靠的强制点是 `agent.ctx.tools.guard(exec => string|undefined)`——它**单调**（任何守卫都无法把别人的拒绝翻成允许），且只作用于注册时所在的 agent 作用域。
4. **不要用 `tools.get(name)` 探测能力。** 实测全局视图与 agent 视图对 `read/bash/edit/write` **全部返回 `undefined`**，但守卫证明它们全都可调用。只有守卫里的 `exec.name` 是地面真相。
5. **插件的 row config 通过 `apply(ctx, config)` 的第二个参数传入**（参照 dsh-synapse 的写法）。
6. **计费口径**：上游 `totalTokens = input + output + cacheRead`，而 `cacheRead ⊂ input`（缓存段被重复计入一次），官方 UI 显示值实测 = `Σ totalTokens ÷ 2`。本插件预算一律用 **`billed = input + output`**，**故意与 UI 不同**，别去「修正」它。

## 环境（都在本机，已就绪）

```sh
export PATH="$HOME/.hermes/node/bin:$PATH"     # dsh 0.2.0-rc.2 在这里
cd ~ && pkill -f "dsh --profile quorum"; sleep 2
nohup dsh --profile quorum --port 3097 --no-open > ~/.qoder-cn/tmp/dsh-boot.log 2>&1 &
sleep 10 && grep -o 'token=[A-Za-z0-9_-]*' ~/.qoder-cn/tmp/dsh-boot.log | tail -1
```

- 插件改了代码要**重启服务**（HMR 只监视配置，不监视插件代码）。
- 会话日志在 `~/.dsh/sessions/--Users-wweiqi-Documents-deepseek-harness-default-workspace--/<sessionId>/session.v4.jsonl.zstd`，用 `~/miniconda3/bin/zstd -dc <文件>` 解压成 JSONL 逐行读。
- 靶子工作区 `~/Documents/deepseek-harness/default-workspace` 是个 git 仓库（`calc.py` 里 `add` 故意写成减法、有 `test_calc.py`、`NOTES.md`）。当前 `calc.py` 已被上一轮改过（`git status` 显示 M），不影响继续测试。

## 验收标准（按顺序做，第一条不花 token）

### 第一步（必须零成本先过）

实现 `quorum/binding` 追加 → 重启服务 → 用浏览器连接器打开启动日志里那条**带 token 的 URL**（页面会恢复会话并触发 `agent/created`，**不发任何模型请求**）→ 解压该会话的 `session.v4.jsonl.zstd`，确认里面出现了 `quorum/binding` 事件。

> 这一步在验证一个真正的未知数：**插件自定义的事件类型能不能被会话日志接受。**
> 如果失败（比如日志对事件类型做白名单校验），**立刻停下**，把原始报错贴出来。**不要改用别的存储方式绕过**——写文件、写数据库都不算数，那正是本插件要反对的做法。

### 第二步：`quorum/denial` 落盘验证

需要触发一次真实拒绝。允许花 token，但**发任何模型请求前，先说明预计成本**。

实测基线（用于估算）：

| 场景 | 实测 |
|---|---|
| Lead 单派一个只读审查者 | ≈ 76K billed / 6 步 / 1 分 7 秒 |
| 三路径验收轮 | ≈ 91K billed（lead 53.5K + 两成员 25.4K / 12.3K） |
| 两成员并发 + 任务板那轮 | ≈ 361K（UI 口径） |

最省的触发方式：让 Lead 建一个 reviewer teammate 并命令它把结论写入某个文件，**只此一个动作**。

浏览器操作提示：dsh 的输入框是 contenteditable，`fill` 写不进去；要用 `evaluate_script` 执行 `execCommand('insertText')`，**且框架状态更新是异步的，必须再查一次发送按钮的 `disabled` 才能确认**。新会话入口是顶栏「新建会话」按钮。

### 第三步：更新文档

- `docs/verification.md`：按现有格式追加新证据（**原始命令 + 原始输出**，不要写成总结）。
- `docs/architecture.md`：若已解决，删掉「已知限制」里「拒绝记录目前不写持久事件」那一条。

## 只读参照（可以读，绝对不要修改）

- `~/.dsh/profiles/desktop/node_modules/dsh-synapse/` —— 已安装的第三方插件活样本。看它的 `package.json`（`dsh.bundle` + `dsh.client` 双 manifest）、`cordis.patch.yml`（只 insert 一行，config 里能用 `!!js` 表达式）、`docs/architecture.md`（尤其 **"Model and KV-cache impact"** 一节的边界写法——任何往模型上下文里加东西的插件都被期待回答这个问题）。
- `~/.hermes/node/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/` —— dsh 自带 288 个包。`dsh-tools/lib/types/index.d.ts` 是工具与守卫的类型真源；`dsh-experimental-agent-team/lib/index.js` 是持久事件写法参照。
- `~/.dsh/profiles/quorum/` —— 你的插件就装在这个 profile 里。

**禁止修改**：

- `~/.dsh/profiles/desktop/`（桌面 App 拥有它）
- `~/.dsh/cordis.patch.yml`（home 级，会同时影响桌面版）
- `/Users/wweiqi/Desktop/update plan/Quorum` 整个目录

## 交付

1. 改完的 `index.js`
2. 更新后的 `docs/verification.md` 与 `docs/architecture.md`
3. 一份简报：第一步的原始事件证据；第二步的拒绝事件原始内容（若已执行）；以及你新踩到或发现的**任何与上面清单冲突的事实**。

> **如果实测结果推翻了清单里某条，明确说出来并给出证据，不要默默迁就我的假设。**

## 后面还有活（本次不做，但设计时要留位置）

- **D3 终止纪律**：法定人数、证据门禁、scout→ship 形状切换门禁、以及**自己实现踢醒循环**——上游 `wait_agent` 唤不醒未运行的成员（实测 `noProgress` / `reason: no-active-peer`），这条必须插件自己扛。
- **投影与 UI**：`ctx.sessionProjections.register` 需要声明式 map key 与 wire schema，不确定性高，故意押后。目标是让「谁被哪条规则拦住」在界面上可见。
- **`withinScopes` 目前是子串匹配，`src/../secrets` 能绕过**——它防模型误操作，不防恶意。要做成安全边界得换成解析后的真实路径比较。
