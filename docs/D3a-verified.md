# D3a 验收：普通会话豁免（已证）

日期：2026-10-03 17:40　成本：**0 token**

## 判据设计

「没有输出」不能证明豁免——它同样可能意味着 `agent/created` 压根没触发。所以先给豁免分支加一条显式日志，把「被豁免」和「未触发」区分开，再对照落盘 roster 做交叉判定。

## 原始输出

重启 `quorum` profile 后，启动期恢复的两个会话各打一行：

```
$ cd ~ && pkill -f "dsh --profile quorum"; sleep 2
$ nohup dsh --profile quorum --port 3097 --no-open > ~/.qoder-cn/tmp/dsh-boot.log 2>&1 &
$ sleep 12 && cat ~/.qoder-cn/tmp/dsh-boot.log
dsh web: http://127.0.0.1:3097/?token=_TfKNqx7…
[quorum] policing "lead" (ship) team=session-a86ccf90-ccdc-4365-b431-fc1419933cfe
[quorum] EXEMPT team-of-one session session-de1d78f3-c7ec-4016-9cd2-cb3e33be0a51
```

## 交叉判定（读落盘会话日志，不看插件自述）

| 会话 | 事件数 | `team/member` | 插件行为 | 是否符合预期 |
|---|---|---|---|---|
| `session-a86ccf90` | 258 | **4** | `policing "lead"` | ✅ 真团队被约束 |
| `session-de1d78f3` | 5 | **0** | `EXEMPT team-of-one` | ✅ 普通会话被豁免 |

全量枚举（同工作区 8 个会话）：只有 `session-a86ccf90` 带 `team/member`，其余 7 个为 0；其中 `5a8357c3` / `14a6b7c9` / `056e9310` / `bd9211e9` 是它的**成员会话**（roster 只存在 Lead 日志里，成员自己日志为 0 属正常）。

## 结论

「安装本插件不改变普通会话行为」这个保证，现在**由代码分支保证**，不再依赖 `lead` 卡片的配置值碰巧宽松。任何人给 `lead` 卡加 `writeScopes`，普通会话仍然零影响。

## 一处需要后续处理的遗留（已于 D3c 处置，2026-10-03 18:3x）

`[quorum] EXEMPT …` 目前是 `console.log`，会给**每个**普通会话启动都打一行，属于噪音。它同时是「被豁免 vs 未触发」唯一的区分手段，所以不能简单删掉。

建议：改成一个配置开关（如 `config.debug.logExemption`）控制，默认关；或者降级为 `ctx.logger.info`（实测 `ctx.logger` 不落 stdout，因此线上安静、需要时另找出口）。

**已按第一条建议实现**：`index.js` 里改为 `if (config.debug?.logExemption)`，`cordis.patch.yml` 新增 `debug: { logExemption: false }`。没有选 `ctx.logger.info`，因为 D2 已实测 `ctx.logger` 在本机构建里三条出路全堵，等于把这条判据变成不可观测。验收与两向真机证据见 `verification.md` 的 D3c 一节（默认态启动日志零噪音）。

副作用记录：这一行让 `test/enforcement-scope.test.js` 第 1 条的「普通会话不得有任何 `[quorum]` 行」断言从写完那天起就与代码互斥——交接时该文件实际是 4 pass / 1 fail，不是 5/5。
