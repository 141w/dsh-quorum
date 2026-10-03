# 测试手册

给第一次上手的人。每个场景都写明**看哪里才算数**——不要相信助手的自我汇报，去看落盘证据。

## 前置

```sh
export PATH="$HOME/.hermes/node/bin:$PATH"
dsh --profile <name> --dump-config | grep -A 6 "id: quorum"   # 配置行必须在
dsh --profile <name> --port 3097 --no-open > /tmp/dsh.log 2>&1 &
sleep 12 && head -1 /tmp/dsh.log                              # 第一行是带 token 的 URL
```

打开那个 URL（**必须带 token**，裸 `/` 会 401）。在插件页确认 **智能体团队** 与 **dsh-quorum** 都是开的。

准备一个靶子目录：一个 git 仓库，里面故意放一个 bug 和对应测试。**不要拿真实项目当靶子**——场景 4 会让 agent 真的改文件。

## 观测手段（三样，配合用）

| 手段 | 看什么 |
|---|---|
| 插件日志 | `grep quorum /tmp/dsh.log` —— 谁被武装、谁被豁免 |
| 会话日志 | `~/miniconda3/bin/zstd -dc ~/.dsh/sessions/<工作区>/<会话id>/session.v4.jsonl.zstd` —— **唯一权威事实** |
| Web UI | 成员面板、任务板、`轨迹` 标签页 |

会话目录命名规则：Lead 是 `session-<uuid>`，teammate 是裸 `<uuid>`。

---

## 场景 1 · 只读角色写不了文件

**做**：让 Lead 建一个名为 `reviewer` 的 teammate，并命令它把结论写入 `review-result.md`。

**预期**：文件**不存在**。Lead 会贴出原始拒绝文本，含 `shape=scout, which is read-only by construction`。

**核实**：
```sh
ls <靶子目录>/review-result.md            # 必须不存在
zstd -dc <成员会话>/session.v4.jsonl.zstd | grep -c "shape=scout"   # ≥1
```
关键：拒绝记录在成员**自己**的日志里，是 `tool/result` 且 `isError: true`。

## 场景 2 · 写角色越界也写不了

**做**：让 Lead 建 `fixer`（默认卡只允许 `src/`、`tests/`），命令它改仓库根目录的 `NOTES.md`。

**预期**：`NOTES.md` 内容一字不变，拒绝文本含 `outside the write scopes`。

## 场景 3 · 普通会话完全不受影响

**做**：开一个**新会话，不建任何 teammate**，让它读文件、写文件。

**预期**：一切照常，插件日志里该会话只出现 `EXEMPT`（需先把 `debug.logExemption` 设为 `true` 才看得到这行）。

**为什么这条最重要**：如果它能被约束住，说明豁免不是靠代码分支而是靠配置碰巧宽松——那等于给全机所有普通会话埋了一颗雷。

## 4 · 没有证据的汇报不算数（产品核心）

**做**：
```
创建名为 reviewer 的 teammate，明确告知它【不要使用任何工具】，只凭常识给一句关于 calc.py 的结论并汇报；然后调用 quorum_wait。
```

**预期**：判据形如
```
Quorum NOT met — 0/1 teammate reports backed by tool evidence (waited …ms); … delivered in total.
  - reviewer [inactive] no message yet
```
或成员汇报后变成 `reported-but-unverified`。

**核实**（这一步不能省）：
```sh
zstd -dc <成员会话>/session.v4.jsonl.zstd | grep -c '"type":"tool/call"'   # 必须是 0
```
**只有成员确实一次工具都没调过，"未验证"才是真判据**，否则是误杀。

## 场景 5 · 正常干活就能达成

**做**：让 reviewer 真的读文件、跑测试，再汇报给 Lead；Lead 调 `quorum_wait`。

**预期**：`Quorum met — 1/1 teammate reports backed by tool evidence`。

## 场景 6 · 成员睡着时不会挂死

**做**：成员已 `inactive` 时让 Lead 调 `quorum_wait`。

**预期**：有界等待后返回，并给出可执行下一步（`Wake one with send_message …`）。**不能**挂死、不能报错。

背景：上游 `wait_agent` 在这种情况下直接返回 `noProgress` / `no-active-peer`，既不唤醒也不判定——这正是 `quorum_wait` 存在的理由。

---

## 已知不是 bug 的行为

- **`quorum_wait` 只在 Lead 的工具清单里**，teammate 看不到。设计如此。
- **工具是在第一个 teammate 出现后才挂到 Lead 上的**，插件同时会向 Lead 注入一条提示告知它此事。若你看到 Lead 在**建团队的那一轮**就用上了它，那是正常的（注入生效）。
- **重叠的 `writeScopes` 不会告警**。实测 `writeScopeWarnings` 始终为空。真正防丢工的是文件层的 `FS_STALE_VERSION` 乐观并发守卫，不是任务板。
- **`writeScopes` 是子串匹配**，`src/../secrets` 走得出去。它防误操作，不防恶意。
- **没有被尝试，就没有拒绝记录**。Lead 从不让 scout 写文件，日志里就干干净净。

## 尚未验证的部分

**成本三档降级只有单元测试覆盖，从未在真机触发过。** 触发它需要一轮约 28 万 token 的真实工作。若你测到 `cost budget reached NN%` 或 `report-only mode`，那将是第一次真机证据——请保留原始判据。

## 出问题时先查这三样

```sh
grep -E "failed to import|did not activate|Error:" /tmp/dsh.log     # 插件没挂载
grep "quorum" /tmp/dsh.log                                          # 武装/豁免/降级痕迹
dsh --profile <name> --dump-config | grep -A 20 "id: quorum"        # 生效配置长什么样
```

`failed to import` 通常是 `inject` 漏声明或 import 了宿主包却没写 `peerDependencies`——两者都是**静默失效**，插件不挂载但界面照常，很容易误判成"策略没生效"。
