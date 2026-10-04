# M1 实测：token 计费口径

日期：2026-10-04　成本：**0 token**（只读落盘日志，无模型请求）
复现：`node .probe/m1-usage-accounting.mjs`

## 为什么要测

插件的成本纪律基于一个口径假设，而这个假设写在代码注释里当作事实：

```js
// index.js
/** totalTokens double-counts cacheRead; bill on the non-overlapping terms. */
function billedTokens(usage) { return input + output }
```

上游自己的头文件说的是相反的话（`dsh-llm/lib/types/types.d.ts:153-158`）：

> Counts are **DISJOINT**: `inputTokens` is uncached input only; cached input is reported separately as `cacheReadTokens`/`cacheWriteTokens` (**billed input = sum of the three**).

两边不可能都对。注释不是证据，头文件也不是证据——**落盘日志才是**。所以直接读 `~/.dsh/sessions/**/session.v4.jsonl.zstd` 里每一条 `assistant/message` 的 `usage`。

## 样本

18 个会话、**449 次** `assistant/message` 调用（含 2026-10-03 那一轮真实 Agent Team：1 Lead + 2 名成员）。

字段出现次数：

| 字段 | 出现 |
|---|---|
| `inputTokens` | 449/449 |
| `outputTokens` | 449/449 |
| `cacheReadTokens` | 433/449 |
| `cacheWriteTokens` | 333/449 |
| `totalTokens` | 449/449 |
| `prompt_tokens` | **0/449** |
| `completion_tokens` | **0/449** |

只有三种字段组合，全部是上面五元组的子集。原始样本：

```json
{"inputTokens":1828,"outputTokens":206,"cacheReadTokens":7424,"cacheWriteTokens":0,"totalTokens":9458}
```

## 判定

**449 条样本上，`input + cacheRead + cacheWrite + output` 与 `totalTokens` 精确相等（delta = 0）。**

```
sum(totalTokens)                        34,062,771
sum(input+cacheRead+cacheWrite+output)  34,062,771   ← delta 0
sum(input+output)                        1,046,195   ← 偏低 96.9%
```

因此：

| 口径 | 值 | 相对 |
|---|---|---|
| A `input + output`（插件当时的写法） | 1,046,195 | 1.00x |
| B `input + cacheRead + cacheWrite + output` | 34,062,771 | **32.56x** |

缓存读占全部计费的 **96.9%**。头文件是对的，代码注释是错的。

## 两个后果（这是这次测量的价值）

### 1. "三档从未真机触发"有一个此前没被识别的原因

旧口径下，一个真实团队轮的计费只有真值的 1/32，阈值几乎不可能被触及。这不只是"没测到"，是**测得的东西本身太小**。

### 2. 只改公式会把每个用户的预算瞬间变成 1/32

两件事必须同时改。实测出真实一轮的量级（正确口径）：

| 会话 | 角色 | 调用 | billed |
|---|---|---|---|
| `session-a86ccf90` | Lead | 32 | 759,983 |
| `5a8357c3` | member | 19 | 341,749 |
| `bd9211e9` | member | 18 | 257,870 |
| | | **69** | **1,359,602** |

归属由 Lead 自己的 `team/member` 行决定（`teamId` = Lead 的 sessionId），因此只含严格成员。**这个数字在一稿里写错过**：当时手工把同工作区另外两个并发会话（`056e9310`、`14a6b7c9`）也算成了成员，得到 1,478,047 / 96 次调用。它们是同一工作区里跑过的独立会话，从未被编入这个团队。是可复现的检查脚本（`.probe/cost-tier-check.mjs`）把这件事暴露出来的——这正是"不要手工汇总、要让脚本按落盘 roster 算"的理由。

同口径下旧口径的数字是 448,173（69 次调用）。所以旧的 `maxBilledTokens: 400000` 有两个方向的错：在旧口径下它等于这一轮的 89%（差一点就触发，但永远差一点），在新口径下它等于 29%（一旦口径修正就立刻触发）。

新默认值 **2,000,000**：这一轮占 **68%**，一轮绰绰有余，第二轮或更大的团队会触及 soft 档（1,400,000）。

**注意这一轮并没有触发任何一档**，所以它仍然不是成本纪律的真机证据——它只是把阈值标定到了真实用量量级上。真机验证见 `docs/D6-cost-tier-live.md`。

## 复现命令

```sh
node .probe/m1-usage-accounting.mjs
```

脚本只读：`zstd -dc` 解压，逐行 JSON 解析，打印统计。不写任何文件。

## 结论

1. 计费口径改为 `input + output + cacheRead + cacheWrite`（= `totalTokens`）；
2. 默认预算随口径重定为 `2,000,000`，并在 `cordis.patch.yml` 里写明它是按实测重定的，不是拍脑袋；
3. `prompt_tokens` / `completion_tokens` 两个旧名回退保留但已无样本命中，注释说明它们只是回退。
