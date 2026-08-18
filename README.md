# dsh-chat-navigator

DeepSeek Harness (dsh) web plugin — 右侧轮次导航条 + 对话折叠。

## 功能

1. **右侧锚点簇（轮次导航）**
   - 贴会话列右缘、以会话列高度约 **0.6（可调）** 为锚点（簇中心，自动限制在列内）；
   - **滑动窗口**：固定显示 **6 个**圆点（窗口），每次仅显示窗口内的轮次；在簇上**滚轮**即平滑滑动窗口（每次 1 轮，transform + CSS transition，**先慢后快 ease-in** 曲线）；当前阅读轮离开窗口时窗口自动跟随滑入；视口四周预留光晕余量，当前轮阴影在悬停放大时不会被矩形视口截断；
   - **悬停放大**：悬停的圆点 `scale(1.55)` 平滑放大，同时弹出**操作卡片**（渲染在视口之外不被裁剪）：该轮首条用户提问摘要（≤80 字）+「折叠本轮 / 展开本轮」+「跳转」；
   - **点击圆点 = 平滑跳转**到该轮开头；已折叠轮的圆点变暗空心，点击 = 展开并跳转；
   - 按轮类型着色：含工具调用 → 品牌色，含错误 → 错误色，普通 → 次要文字色；
   - 空会话 / 窗口加载中 / 错误态 / 内容不足以滚动时自动隐藏。

2. **折叠**
   - **整轮折叠**：入口在右侧圆点簇的**悬停操作卡片**（每个轮都有圆点，故每轮都有折叠入口）；折叠后该轮**全部行**隐藏；
   - **折叠守卫**：不允许折叠全部轮——折叠后若所有轮都已折叠，自动展开会话顺序中的**下一轮**；被折叠的是最后一轮则展开**上一轮**；仅一轮的会话不提供折叠按钮；
   - **单条助手消息折叠**：每条已最终化的助手消息行内「折叠此消息」按钮（正文图标行，非正文末尾）；折叠后该行隐藏；
   - **已折叠读条**：输入区下方的常驻读条列出所有已折叠项（「已折叠 N 项：展开第 3 轮（5 条）…」），支持逐项展开与「全部展开」；
   - 有折叠项时圆点簇**不因滚动高度不足而隐藏**（全折叠时簇仍保留，作为展开入口之一）；
   - 折叠状态仅内存（按会话），刷新页面即恢复展开；插件停用自动恢复全部被隐藏的行。

3. **分叉（fork）与家族树（V2）**
   - **圆点分叉**：悬停卡片「在此分叉」（两步确认）→ 从该轮收尾处 `sessions.fork` → 自动切到子会话；分叉轮圆点右下角显示短横线标记；
   - **分支子会话列表**：悬停分叉轮，卡片列出子会话（点击打开）；
   - **家族树面板**：会话头部「🌳 分支树」按钮打开无遮罩浮层，显示当前会话的根→子孙树（纯 client 血缘数据）；节点支持点击切换、面板内分叉（尾部，运行中禁用）、**归档**（移到兄弟末尾 + 删除线）、**物理删除**（内置端点，两步确认）；默认只展开当前路径，ESC/关闭按钮退出；
   - 分叉标记覆盖**本插件创建 + 官方 fork** 的分叉（官方 fork 通过 `ctx.remote.sessions.history` 分页拉父子日志、公共前缀对比推断分叉边界，缓存一次）。

## 实现要点

- **双端插件**：host 半提供 `POST /chat-navigator/api/delete`（物理删除会话，实现移植自 dsh-session-manager，MIT 署名见 `lib/index.js`）；client 半注册四个加性 Slot：
  - `conversation.session.header.utilities` → 圆点簇（跳转 + 悬停卡片折叠/分叉）+ 分支树按钮/面板；
  - `conversation.chat.assistant-actions` → 单条助手消息折叠；
  - `conversation.composer.dock` → 已折叠读条（逐项 / 全部展开入口）。
- **注意**：修改 `lib/index.js`（host 半）后需**重启 dsh web** 才生效；纯 client 改动走 HMR 即时生效。
- 数据来自 session 标准 kit 的 `useSession`：`chat.order`（节点顺序）+ `chat.nodes.get(key)`（节点 kind/seq/location/data）。
- 滚动与跳转复用官方机制：`[data-conversation-scroll]` 滚动容器、`[data-chat-anchor-key]` 节点行、`flowTop` 相对定位、直接改 `scrollTop`（锚点簇本身 fixed 固定，不随滚动移动）。
- 颜色全部使用 `--dsw-alias-*` 主题 token，深浅色自动适配。
- 若官方 DOM 属性在版本升级后变更，进度条自动隐藏、折叠按钮失效，不崩溃。

## 安装

### 本机开发（link 到仓库目录）

```bash
# 1. 在 web profile 的 cordis.patch.yml 追加行：
#    - insert:
#        - id: dsh-chat-navigator
#          name: 'dsh-chat-navigator'

# 2. 安装依赖（link 到本仓库目录）
dsh plugin --profile web add "link:D:/prj_dsh_plugin"

# 3. 重启 dsh web（新增插件行需重启加载）+ 刷新页面
```

### 分发给其他用户（git 仓库）

```bash
# 1. 安装依赖（从 git 拉取，按 tag 固定版本；GitHub 写法见注释）
dsh plugin --profile web add "git+https://github.com/sean-bike/dsh-chat-navigator.git#v0.1.0"
#   GitHub 也可简写：dsh plugin --profile web add "github:sean-bike/dsh-chat-navigator#v0.1.0"

# 2. 在 web profile 的 cordis.patch.yml 追加行：
#    - insert:
#        - id: dsh-chat-navigator
#          name: 'dsh-chat-navigator'

# 3. 重启 dsh web + 刷新页面
```

- 版本要求：dsh `0.1.0-rc.6`（按此版本验证；依赖 `conversation.session.header.utilities` / `conversation.chat.assistant-actions` / `conversation.composer.dock` 座位与 `[data-conversation-scroll]` 等 DOM 属性，官方属性变更时插件优雅降级不崩溃）。
- 升级：发布新 tag 后，接收者执行 `dsh plugin --profile web add "git+<url>#<新tag>"` 更新依赖并重启即可（纯 client 插件，正文改动亦可走 HMR，但换 tag 需 pnpm 更新）。

## 已知限制

- 进度条仅覆盖已加载的历史窗口（`hasMore` 之前的内容不在条上）。
- 会话级节点（compaction 摘要等）不生成轮标记。
- 用户消息 / 工具调用行不做单条折叠（官方无逐行加性座位，避免替换官方渲染器）。
