# D6：成本三档的真机验证（尚未执行）

日期：2026-10-04　状态：**未跑，这是操作手册**
检查脚本：`node .probe/cost-tier-check.mjs`（只读、可复现，用落盘日志判定）

## 为什么这一层还没有证据

四条纪律里，能力、终止、证据都有真机证据与原始输出。成本没有，而且原因和"没时间测"不同：

旧口径（`input + output`）把真实用量少算了 96.9%，于是阈值在物理上几乎不可达。2026-10-03 那一轮真实团队（1 Lead + 2 成员）在旧口径下只有 **448,173**，而当时的默认阈值是 400,000——**差一点就触发，但永远差一点**。所谓"三档从未触发"因此不是运气问题，是标定问题。

0.2.0 修正了口径并重定阈值为 2,000,000。同一轮在新口径下是 **1,359,602（68%）**——**仍然没有触发**。所以这一层到今天为止依然是零真机证据，只是它现在**可以被触发了**。

## 判据设计（先说清楚什么算过）

| 结果 | 判定 |
|---|---|
| 越过 soft 档，且日志里出现 `cost budget reached NN% of ... billed tokens` 的**拒绝**（`isError: true`） | PASS |
| 越过 hard 档，且写入类工具被 `report-only mode` 拒绝 | PASS（更强的证据） |
| 越过了某一档，**但没有任何拒绝记录** | **FAIL**——预算停止执行而插件看起来仍然装好着。这正是本项目存在的理由那一类 bug |
| 没越过任何档 | 本轮不构成证据（脚本会这么说，不会假装通过） |

关键点：**判据来自落盘日志，不来自助手的自述。** 拒绝文本会作为普通的 `tool/result`（`isError: true`）落进会话日志，脚本按 `toolCallId` 反查工具名，所以能区分"谁在什么时候想干什么被拒了"。

## 操作步骤

### 1. 准备一个一次性靶子

```sh
mkdir -p /tmp/quorum-budget-target && cd /tmp/quorum-budget-target
git init -q . && printf 'def add(a, b):\n    return a + b\n' > calc.py
git add -A && git -c user.email=t@t -c user.name=t commit -qm init
```

用 **quorum profile** 起服务（Agent Teams 必须开着，否则插件不激活）：

```sh
dsh --profile quorum --port 3097 --no-open > /tmp/quorum-budget.log 2>&1 &
sleep 12 && head -1 /tmp/quorum-budget.log      # 带 token 的 URL
```

### 2. 把预算临时调低到"一轮必爆"

不要真的去烧掉 140 万 token。**把阈值压到本轮必然越过的位置**，观察降级行为——这才是要验证的东西（降级是否发生、形态是否可读），不是要验证某个具体数字。

在 profile 的 `cordis.patch.yml` 里覆盖 quorum 行（patch 语义是**整体替换 `config`**，必须重述全部键）：

```yaml
- id: quorum
  name: dsh-quorum
  config:
    roles:
      lead:     { shape: ship, writeScopes: [], maxMembers: 4 }
      reviewer: { shape: scout, allow: [read, read_image, grep, glob, list] }
    defaultRole: { shape: scout, allow: [read, read_image, grep, glob, list] }
    budget:
      maxBilledTokens: 60000      # ← 低到一轮就会越过
      softTier: 0.7               # soft = 42,000
      hardTier: 0.9               # hard = 54,000
    quorum: { requires: all, timeoutMs: 300000, pollMs: 30000 }
    debug:  { logExemption: false }
```

改完重启 profile。**验证配置真的生效**（不要相信改动生效了）：

```sh
dsh --profile quorum --dump-config | grep -A 20 "id: quorum" | grep maxBilledTokens
# 必须打印 60000，而不是 2000000
```

一条更省的路径（不改 profile 文件）：在低预算下用一个**只读、单成员**的团队跑一轮，让它做几十次 `read`/`grep` 就够跨越 42,000。

### 3. 给 Lead 的任务（逐字）

```
在 /tmp/quorum-budget-target 里创建一个名为 reviewer 的 teammate（角色卡是只读的 reviewer）。
让它：读取 calc.py，然后对 3 个不同文件做 grep，把每个结果原样汇报给你。
它汇报之后：
1. 再创建第二个名为 fixer 的 teammate，让它修改 calc.py 的 add 函数；
2. 然后你自己尝试往 /tmp/quorum-budget-target/NOTES.md 写一行字。
每一步都要把你收到的原始返回贴出来，不要转述。
```

**预期（soft 档已在前面被只读工作越过）**：

- 第 1 步：`spawn_teammate` 被拒，理由含 `cost budget reached NN% of 60000 billed tokens; conclude with the members you already have instead of adding another`；
- 第 2 步：如果预算继续增长越过 hard 档，`write` 被拒，理由含 `report-only mode`；
- 如果没越过 hard，第 2 步照常成功——那也是正确结果，不要把"没触发"读成失败。

### 4. 不看助手自述，看落盘证据

```sh
node .probe/cost-tier-check.mjs --lead <Lead 会话 id> --budget 60000
```

脚本会打印每一档是否被越过、越过的第一条消息在哪个 seq、以及**是否真的产生了拒绝**。

再手工复核一次拒绝原文：

```sh
~/miniconda3/bin/zstd -dc ~/.dsh/sessions/<工作区目录>/<Lead会话>/session.v4.jsonl.zstd \
  | grep -o "cost budget reached [0-9]*%[^\"]*" | head -3
~/miniconda3/bin/zstd -dc ~/.dsh/sessions/<工作区目录>/<成员会话>/session.v4.jsonl.zstd \
  | grep -o "report-only mode[^\"]*" | head -3
```

### 5. 记录（这一层就欠这一份）

跑完请把原始输出贴进 `docs/verification.md` 新开的一节，格式照 D3b/D4：

- 本轮 billed 总数（脚本输出的那行）与阈值；
- 第一次拒绝的原始文本、所在会话与 seq；
- 拒绝了什么工具（`spawn_teammate` / `write` / `str_replace_editor`）；
- **如果某一档被越过却没有拒绝**，那是一个必须修的真 bug，直接记进 `CHANGELOG` 的 Fixed。

## 两个已知的判定陷阱

1. **插件只统计 `agent/created` 时建立映射的会话。** 成员在其映射建立前产生的用量会计入不到。所以脚本的总数可能比"真实花费"略低——验证降级行为没问题，别拿它当账单。
2. **`spend` 是按 `teamId` 聚合的常驻 Map，重启即清零。** 重启 profile 之后预算从头算。所以如果要观察 hard 档，必须**在一次运行内**越过它，不能靠累积。

## 附：本手册写定时跑过的对照

```
$ node .probe/cost-tier-check.mjs --lead session-a86ccf90-ccdc-4365-b431-fc1419933cfe
  lead   session-a86ccf90-...  calls= 32  billed=759,983
  member 5a8357c3-...          calls= 19  billed=341,749
  member bd9211e9-...          calls= 18  billed=257,870
  billed total: 1,359,602  (68.0% of budget)
  crossed soft: no    crossed hard: no
  denials: none recorded
  VERDICT: no tier was reached — this round is not evidence either way.
```

这份对照有两个用处：它证明脚本能正确按 roster 归属（同一工作区的另外两个并发会话没有被算进来），也再次说明这一层到今天仍然是零真机证据。
