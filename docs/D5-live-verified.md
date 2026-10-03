# D5 真机验证：时序修复 + 证据门禁

日期：2026-10-03 23:29　成本：**57.6K token（UI 口径）/ 1 轮 4 步 / 缓存命中 51%**

## 背景：上一轮真机暴露的缺陷

2026-10-03 22:58 那轮（57.6K 之前的一次，184K）里，Lead 明确报告：

> `quorum_wait` 不在我本会话可用的工具清单中，DSH 环境中对应的工具是 `wait_agent`。我不会虚构一个 `quorum_wait` 的返回值。

查日志确认工具**确实注册成功了**，但只进了**第二次**提示词组装——因为 `quorum_wait` 只能在第一个 teammate 出现后武装，而那时 Lead 本轮的提示词早已组装完毕。

**结论：一个模型不知道它拥有的工具，等于没有这个工具。** 25 条单测全绿完全覆盖不到这个时序缝隙。

修复：武装 Lead 的同时，用 `agent.inject()` 注入一条模型可见的通知。

## 修复验证

Lead 在**创建团队的那同一轮**成功调用了 `quorum_wait`，并逐字贴出返回：

```
Quorum NOT met — 0/1 teammate reports backed by tool evidence (waited 11868ms); 0 delivered in total.
  - reviewer [inactive] no message yet
  every member not counted toward the quorum (reviewer) is inactive or failed.
  Wake one with send_message and require the tool output behind its claim, or
  conclude and name who never reported with evidence.
```

## 证据门禁验证（产品核心主张）

实验设计：命令 reviewer **不得使用任何工具**，只凭常识给一句关于 `calc.py` 的结论并汇报。

**成员实际产出：**

> 按常理推断，calc.py 很可能是一个 Python 计算器脚本，用于对输入的算术表达式进行解析、求值并输出计算结果。

**独立核实（不看任何自述）：**

```
成员会话 bfb644d9-2c79-4ff0-b042-5e62fd1610cd
events: 18   ← 其中 tool/call 数量：0
```

该成员**一次工具都没有调用过**。所以「未验证」是**真判据，不是误杀**。

**Lead 自己对规则的复述（说明注入与提示词声明都生效）：**

> 这条汇报属于「已报告但未验证」（reported-but-unverified）——它内容全靠常识，背后没有任何成功的工具调用记录，按 quorum 规则**不计入 quorum**。

**这就是产品主张的落地形态：「说了」和「查了」被机制区分开，而不是靠人去看一眼。**

## 测试桩的一个假绿（同轮发现）

新增成本降级测试时，第一次运行失败，原因在测试桩而不在插件：

`session/event` 监听器签名是 `(session, event)` 两个参数，而 harness 的 `emit(type, payload)` 只转发**一个**参数——于是监听器里的 `event` 永远是 `undefined`，函数第一行就 return，**任何依赖事件流的断言都会静默通过或静默不执行**。

已改为 `emit(type, ...args)` 转发全部位置参数。

同时，测试桩的 agent 对象**没有 `inject` 方法**，导致新加的注入代码抛 `TypeError`、被自己的 `try/catch` 吞掉、只记进 `h.lines`，而套件仍然全绿。已补桩并加断言：注入恰好一次、且不得出现 `nudge failed`。

**这两条合起来是一个模式：`try/catch` + 静默降级的代码，必须配一条断言专门盯住"降级有没有发生"，否则它会永久地、安静地不工作。**

## 当前状态

`node --test test/*.test.js` → **27 / 27 全绿**。

四条纪律里三条已有真机证据（权限、终止、证据）；成本纪律有三档行为单测，**仍未在真机触发过**（需要约 28 万 token 的真实工作量）。
