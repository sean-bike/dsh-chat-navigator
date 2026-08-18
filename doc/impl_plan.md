# dsh-chat-navigator V2 实现方案：圆点分叉 + 会话家族树

> 配套 UI 设计：`./doc/tree_ui_design.md`（V2.1）。本文档为**实现规格**，收编三轮拷打结论，
> 与平台事实对齐后确定 V1 范围。
>
> **实施状态：V1 + V2 + 删除内置已实现并热更新**（本地实验，dev 模式 link）。实施内容见 `lib/client.js` + `lib/index.js`：
> 圆点分叉（两步确认 + 记录 + 右下角标记 + 卡片子会话列表）、头部「🌳 分支树」按钮、
> 家族树浮层面板（切换 / 面板内分叉 / 归档置末+删除线 / **物理删除（内置 host 端点，移植自 dsh-session-manager MIT）**）、
> 分支视觉偏好（主色调/6 挡强度/光晕，localStorage）、
> **V2：官方 fork 分叉点推断**（`ctx.remote.sessions.history` 分页拉父子日志做公共前缀对比，
> 得 seedLength → 映射轮次；缓存一次，插件记录的子会话跳过）。

## 1. 需求决策汇总（拷打结论）

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 树粒度 | **会话级**（树节点 = 会话；圆点只代表当前会话的轮次，轮次与对话在 UI 分离） |
| 2 | 分支标记覆盖 | **仅标记本插件 fork** 的分叉轮（client 内存记录；官方 fork 的分叉点 V1 不标） |
| 3 | 分叉点归属 | 边界 seq 落在哪轮就标哪轮（语义：此轮之后有分支） |
| 4 | 分叉确认 | **卡片内两步确认**（按钮变「确认分叉？[确认][取消]」） |
| 5 | 分叉后行为 | fork 成功 → 自动 `sessions.open(childId)` 切到子会话 |
| 6 | 树面板范围 | **当前会话家族**（沿 parentSessionId 上溯到根，再 DFS 收集全部子孙） |
| 7 | 面板打开入口 | **会话头部常驻按钮**（header.utilities 加「🌳 分支树」）；卡片内不放全览按钮 |
| 8 | 面板形态 | 右侧固定浮层 ~320px，**无遮罩**，ESC / 关闭按钮关闭 |
| 9 | 面板节点操作 | 点击切换会话 + 面板内「在此分叉」+「归档」（两步确认） |
| 10 | 卡片操作布局 | 精简两按钮：[折叠本轮/展开本轮] [在此分叉]（去掉跳转/全览） |
| 11 | 分叉标记样式 | 圆点右下角**短横线** |
| 12 | 归档确认 | 面板内两步确认 |
| 13 | 树节点显示 | 标题 + 运行状态 + 当前会话高亮 + 折叠箭头 |
| 14 | 树默认展开 | 只展开当前会话所在路径，其余分支折叠 |
| 15 | 分叉后面板 | 保持打开（高亮自动切到新子会话） |
| 16 | 已砍功能 | 合并分支、拖拽重组、搜索、视图切换、批量选择、导出（V1 不做） |

## 2. 平台事实与约束（已核实）

- **fork 是会话级**：`sessions.fork({ sessionId, atSeq?, increaseTitle? })`（client 服务），从已完成轮前缀新建子会话；`atSeq` 以「该点之后第一个 turn/end」为边界；**运行中的轮不可作为锚点**。官方同款处理器：fork 成功后 `sessions.open(childId)`。
- **血缘**：`SessionSummary.parentSessionId` + `depth`（client `useSessions` 列表直接可得）；**seedLength（分叉边界 seq）不在任何客户端 API**（SessionSummary 无、host SessionsApi 无）→ V1 只用「本插件 fork 时自己记录的 atSeq」。
- **client→host**：`ctx.remote.<ns>.<method>(...)` 可调 host API（如 `sessions.history`），但 V1 不依赖（分叉边界自记录）。
- **归档**：`workspaces.archiveSession(sessionId)`（无硬删除）。
- **会话切换**：`sessions.open(id)`。
- **座位**：`conversation.session.header.utilities`（list，session 作用域）——圆点簇 + 头部树按钮都挂这里；树面板为 fixed 浮层（无遮罩）。
- **DOM 机制**：`[data-conversation-scroll]` / `[data-chat-anchor-key]` 行 / `flowTop` 跳转（复用官方滚动恢复机制）。
- 插件形态：纯 client（V1 无需 host 半）；dev 模式 = profile 依赖 `link:D:/prj_dsh_plugin`（已切换）。

## 3. 总体架构

```
┌──────────────────────────────────────────────┐
│ 模块 A：圆点簇（header.utilities，session 作用域） │
│  · 6 窗口圆点（轮次，现状保留）                    │
│  · 分叉轮：圆点右下角短横线                       │
│  · 悬停卡片：[折叠/展开] [在此分叉] + 子会话列表    │
│  · 分叉两步确认 → fork+open                      │
├──────────────────────────────────────────────┤
│ 模块 B：家族树面板（fixed 浮层，无遮罩）            │
│  · 头部常驻按钮开关                              │
│  · 家族树（useSessions lineage）                │
│  · 节点：点击切换 / 分叉（两步确认）/ 归档（两步确认）│
└──────────────────────────────────────────────┘
```

## 4. 模块 A：圆点分叉 + 分支标记

### 4.1 fork 记录（store 扩展）

内存 store 增加：

```js
forks: Map<sessionId, Map<turn, childId[]>>
```

- 每次本插件 fork 成功后在 `forks.get(sessionId).get(turn).push(childId)`；
- 该数据驱动：圆点标记（右下角横线）、卡片子会话列表（标题经 useSessions 由 childId 解析）；
- 生命周期：随会话 store 一起 `clearSession` 清理（刷新即清，与折叠一致）。

### 4.2 分叉锚点 seq

`buildTurns` 为每轮计算 `forkSeq`（仅已完成轮）：

- 优先：turn-tail 节点的 `data.closing.finalNode.seq`（官方同款锚点）；
- 回退：turn-tail 节点 `data.seq` / 轮内最后节点 `anchorSeq`；
- 无 turn-tail 节点（轮未完成）→ 轮不可分叉（卡片不显示「在此分叉」）。

### 4.3 卡片交互（状态机）

```
idle ──点[在此分叉]──▶ confirm-fork ──点[确认]──▶ forking ──成功──▶ 记录+open(child) → idle
                        │                                            失败──▶ idle + 提示
                        └──点[取消] / 移出卡片──▶ idle
```

- 卡片操作行：`[折叠本轮/展开本轮]` `[在此分叉 | 确认分叉？ [确认][取消]]`
- 分支信息区（有 fork 记录时显示）：`分支：N 个子会话` + 各子会话标题按钮（点击 = `sessions.open(childId)`）。
- 确认态在悬停保留期内可交互；移出卡片/切换圆点自动重置为 idle。

### 4.4 视觉

- 分叉轮圆点右下角短横线（宽 4px 高 1.5px，圆角，距圆点右/下 0px，`--dsw-alias-brand-primary` 或 label-secondary）；
- 标记与悬停放大、当前高亮、折叠空心叠加不冲突（标记画在圆点容器右下角，随 scale 缩放）。

## 5. 模块 B：家族树面板

### 5.1 数据

- 纯 client：`useSessions` 列表（含 parentSessionId、depth、title、running）。
- 家族计算：从当前 `sessionId` 沿 `parentSessionId` 上溯至根 → 以根做 DFS/BFS 收集全部子孙（仅普通 fork 血缘；`origin==='subagent'` 的会话跳过，避免混入子代理）。
- 展开态：`expanded: Set<sessionId>`，初始只含「当前会话所在路径」上的节点；折叠箭头切换。

### 5.2 交互

| 操作 | 行为 |
|---|---|
| 点击节点 | `sessions.open(id)`，高亮切换到该节点，面板保持打开 |
| 折叠箭头 | 展开/收起子树 |
| 「在此分叉」 | 对该会话**尾部** fork（`atSeq` 省略 = 最后事件）；**运行中的会话禁用**（fork 不能落在运行中的轮内），按钮置灰并 title 提示；两步确认；成功后记录（若分叉的是当前会话的某轮语义不适用——面板分叉=该会话尾部，记为 `forks[targetId][末轮]` 或仅面板内可继续）、`sessions.open(child)`，面板保持打开 |
| 「归档」 | 两步确认 → `workspaces.archiveSession(id)`；当前会话被归档时面板关闭 |

### 5.3 形态

- fixed 浮层：右侧贴边（距右缘 8px），宽 320px，高 = 会话列高度 − 16px，圆角，`--dsw-alias-bg-layer-1` + 边框 + 阴影，zIndex 高于圆点簇；
- 头部：标题「分支树」+ 关闭按钮（ESC 或点击关闭）；
- 无遮罩：不拦截主对话交互（浮层自身可交互区域除外）。

## 6. 状态与数据流

- 折叠 store（现有）+ fork store（新增）合并为 session store；`useStoreVersion` 统一驱动重渲染。
- 圆点簇 / 卡片 / 头部按钮 / 树面板共享 `sessionId + useSession + useSessions`，经 apply 捕获的 `ctx.get('sessions')` / `ctx.get('workspaces')` 执行动作。
- 会话切换：sessionId 变化 → 组件重挂载 → fork store 按 sessionId 隔离 → 圆点簇/树自动跟随。

## 7. 边界情况

| 情况 | 处理 |
|---|---|
| 轮未完成 | 卡片不显示「在此分叉」 |
| 单轮会话 | 折叠按钮隐藏（现有守卫），分叉可用 |
| fork 失败（网络/业务） | 回到 idle，卡片显示一次性错误文案（不 toast，避免依赖额外 API） |
| 运行中的会话 | 面板内分叉禁用（title 说明）；归档允许（平台行为） |
| 子代理会话 | 家族计算跳过 origin==='subagent' |
| 家族很大 | 默认折叠 + 只展开当前路径；节点行不渲染子级预览 |
| 当前会话被归档 | 面板关闭；圆点簇随 sessionId 失效自动隐藏 |
| 刷新页面 | fork 记录/折叠/展开全部重置（内存态，与折叠一致） |
| 官方 fork 的分叉点 | V1 不标记（无 seedLength 数据）；V2 用 `ctx.remote.sessions.history` 对比公共前缀补齐 |

## 8. 分期与验证

- **V1（已实现）**：圆点分叉（两步确认 + 记录 + 标记 + 子会话列表）+ 家族树面板（切换/分叉/归档）+ 分支视觉偏好。
- **V2（已实现）**：官方 fork 分叉点标记——`ctx.remote.sessions.history` 分页拉父子会话历史，公共前缀对比得 seedLength（最后一条相同事件 seq），映射到父会话轮次（优先精确命中 turnEnds，否则取最近已完成轮）；插件自建子会话跳过（边界已知）；每 (sessionId+childId) 计算一次并缓存（边界创建后不变）。
- **V3（候选）**：面板搜索 / 导出分支。
- 验证清单：①分叉轮有横线标记；②卡片两步确认后跳转子会话、侧边栏出现缩进子会话；③圆点簇跟随新会话；④头部按钮开关面板；⑤树点击切换/分叉/归档正确、运行中禁用；⑥ESC 关闭；⑦深浅色可读；⑧刷新重置。

## 9. 明确不做的（V1/V2）

合并分支、拖拽重组（改父/移动）、搜索、视图切换、批量选择、导出、轮次级拓扑。
