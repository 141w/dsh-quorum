# D2 结论：审计已经天然持久，自定义事件类型是架构封闭的

日期：2026-10-03　状态：**已定案，方案据此改写**

## 两件事同时被实测证明

### 一、插件不能贡献持久会话事件类型（不是 bug，是设计）

三条独立证据：

1. 会话格式 catalog 的生成文件头部注释原文：**「The direct imports make historical readability independent of mounted plugins.」** —— 会话格式知识**故意不受已挂载插件影响**。
2. `KNOWN_SESSION_EVENT_TYPES` 从 `@deepseek-ai/dsh-session` 静态导入，`team/member` / `team/task` 在表内（上游自己的包），插件自定义类型不在。唯一豁免是信封上的 `ignorable: true`，而 `Session.append(type, data, opts)` 的 opts 只有 `surfaceOp` / `sourceEventSeqs`，**没有任何入口能设这个标记**。
3. 上游自带的插件开发规范原文（`cordis-plugin-development/references/practices.md:21`）：**「Do not append session events with a new `type` … the Session would refuse to reopen.」**

实测后果（写成功、落盘成功、但会话永久毒化）：

```
历史加载失败：failed to observe session "session-91e8cfca-…": contains event type
"quorum/binding" (seq 112) unknown to this harness and not marked ignorable;
refusing to interpret the log — it was likely written by a newer harness（gateway/internal）
```

对照组：同工作区不含该事件的会话正常加载。**该毒化会话已改名隔离到 `.quarantine-poisoned-session-91e8cfca`，未删除。**

### 二、拒绝审计其实早就落盘了

守卫返回的拒绝理由，会作为**普通的工具错误结果**进入会话日志：

```
type=tool/result  seq=114
  content[0].text = "Error: quorum role card: reviewer is read-only, denied by monotonic guard"
  isError = true
```

并且沿链路自然传播（同一会话 seq 117 / 122 / 123 / 127）：成员在推理里引用它、逐字汇报给 Lead，并明确写道自己「**未重试**，也**未改用 bash/edit**」。

## 因此 D2 的活被重新定义

| 原计划 | 修正后 |
|---|---|
| 新增 `quorum/binding` + `quorum/denial` 两类持久事件 | **不做**。架构封闭，且强写会毒化会话 |
| 自己实现审计落盘 | **不需要**。`tool/result(isError:true)` 已是持久、可回放、UI 轨迹可见的事实，且模型必须面对它 |
| —— | 剩下的是**可读性**：用投影**读**现有事件类型，把散落的拒绝聚合成「本轮纪律状态」面板 |

新事件类型这条路封死，反而把方案压得更干净：**插件只读上游已有的持久事实，不发明新的事实存储。** 这也顺带回答了我给交接文档写的那条过头禁令——我当时说「写文件不算数」，但 dsh-synapse 的先例证明插件自有状态文件对**组织性元数据**是合法的（它明确声明该文件不是会话真相、删了不丢对话）。只是现在连这个都不需要了。

## 对整体定位的影响（正面）

「机制级 vs 约定级」这个卖点不但没被削弱，反而更硬：拒绝**以模型无法回避的形式**进入上下文并留下持久记录，而 firstmate 只能靠提示词劝阻 + 外部脚本日志。

**代价**：审计的可见性受限于「拒绝必须真的被模型尝试过」。Lead 如果从不让成员试写，就没有拒绝记录。所以纪律仍然需要一条**主动声明**的通道（角色卡要在提示词组装里可见），这属于 D3 的范围。
