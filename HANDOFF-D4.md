# 交接：D4 证据门禁 —— 没有真实工具执行的汇报不算数

前置：D0–D3 已完成并真机验证。当前 `node --test test/*.test.js` = **13/13 全绿**，先跑一遍确认基线，再动手。

## 要解决的问题

`quorum_wait` 现在只数「有没有 delivered 的 teammate 消息」。但一条**没跑过任何工具、纯编造**的汇报同样会满足法定人数——这正是 Quorum 最初那版「模型自报置信度」的原罪换了个地方复活。**产品全部说服力建立在「结论锚定可验证证据」上，这一格不补，前面的机制级卖点就是半成品。**

## 机制（已确认可行，不要另找路）

```
ctx.sessions.get(member.id) → Session
  Session.toolHistory()
  Session.ownEvents()            // 只含该会话自己的事件
  Session.snapshotEvents(from, to)
```

`TeamMemberView.id` 就是成员的 `SessionId`，所以能直接定位。

**判定规则**：某 teammate 的提交算作 **verified** 当且仅当——在它那条已 delivered 给 Lead 的消息**之前**，它自己的会话日志里存在至少一条 `tool/result` 且 `isError !== true`。否则算 **unverified**。

法定人数只统计 verified。`quorum_wait` 的返回文本必须让 Lead 一眼看出三种状态的区别：`reported+verified` / `reported-but-unverified` / `no message yet`。

## 硬约束

1. **只读，绝不新增会话事件类型。** 已实测：写自定义 `type` 会让该会话**永久打不开**（`KNOWN_SESSION_EVENT_TYPES` 生成期固定、`ignorable` 无法设置）。见 `docs/D2-finding.md`。代码里现在**没有任何 `append(`**，改完也不许出现。
2. **不许让法定人数变成不可达。** B1 那轮的教训：给 scout 的 `allow` 白名单漏了 `send_message`，成员永远交不出、系统静默死锁、**12 条测试全绿没抓到**。所以：
   - 通信类工具（`send_message` / `present`）永远不受白名单管辖，这条已有 `VOICE_TOOLS` 和测试保护，别动。
   - **必须新增一条测试断言「加了证据门禁之后，一个正常跑过工具再汇报的成员仍然能让法定人数达成」**。可达性本身要成为被测试的性质。
3. `export const inject` 要加 `'sessions'`。**漏声明会抛 `cannot get property "sessions" without inject`，后果是新会话完全无法创建**（不是降级）。
4. 零 import 纪律不变：不要 import 任何 `@deepseek-ai/*`。
5. 成员会话可能尚未加载或已被回收 → `ctx.sessions.get()` 返回 `undefined` 时**不能抛错、不能判成 verified**，报成 `unverifiable` 并说明原因。
6. 只统计成员**自己**的事件（`ownEvents()`），注意 fork 继承父日志的情况，别把祖先的历史当成它的证据。

## 验收顺序

1. **先跑基线**：`node --test test/*.test.js`，记录改前的 pass/fail 数字。**报告里必须给出这个基线**，不许写「仍然全绿」而不亲自跑过。
2. 新增单测至少覆盖：跑过工具后汇报 → verified、达成；只汇报没跑工具 → unverified、不达成且给出可执行下一步；成员会话取不到 → unverifiable 而非报错；fork 继承的事件不算证据。
3. `node --check index.js` + 重启服务，启动日志必须干净（无 `failed to import` / `did not activate` / `Error:`）。
4. 以上全过再谈真机一轮（约 130K billed / 5 步 量级）。**发模型请求前先报预估并停下等确认。**

## 环境

```sh
export PATH="$HOME/.hermes/node/bin:$PATH"
cd ~ && pkill -f "dsh --profile quorum"; sleep 3
nohup dsh --profile quorum --port 3097 --no-open > ~/.qoder-cn/tmp/dsh-d4.log 2>&1 &
sleep 13 && cat ~/.qoder-cn/tmp/dsh-d4.log      # 第一行是带 token 的 URL
```

会话日志：`~/.dsh/sessions/--Users-wweiqi-Documents-deepseek-harness-default-workspace--/<id>/session.v4.jsonl.zstd`，用 `~/miniconda3/bin/zstd -dc` 解压。靶子工作区 `~/Documents/deepseek-harness/default-workspace`（git 仓库，`calc.py` 的 `add` 现为正确实现，`test_calc.py` 2 passed）。

浏览器写入注意：dsh 输入框是 contenteditable，`fill` 无效；用 `evaluate_script` + `execCommand('insertText')`，且**必须先「新建会话」再插入**，状态更新是异步的要复查一次。**在一个被反复操作过的 composer 上会失效——失效就重新 navigate 拿干净页面，别硬重试。**

## 禁止

改 `~/.dsh/profiles/desktop/`、home 级 `~/.dsh/cordis.patch.yml`、`/Users/wweiqi/Desktop/update plan/Quorum` 整个目录。用**改名**隔离坏会话（dsh 校验目录名==header id，改名会制造 corrupt 并连带 4 个条目不激活）。大文件一次性 `Write`（会被权限层以「内容截断」拦，拆小 Write + Edit 可通过）。

## 交付

`index.js` 改动 + 新单测 + `docs/verification.md` 追加原始命令与输出 + `docs/architecture.md` 补一节说明证据门禁的判定口径与局限（**「跑过一次成功的工具」不等于「结论正确」**，这条局限必须明写，不要夸大成"验证了正确性"）。逐条列出实际跑过的命令与原始输出；实测与本文件任何前提冲突时明确指出来。
