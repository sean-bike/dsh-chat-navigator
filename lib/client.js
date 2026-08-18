/**
 * dsh-chat-navigator — Browser half (dsh.client module).
 *
 * Plain JS ONLY: no `import`, no JSX, no TypeScript. React arrives via
 * require('react'); UI is built with React.createElement.
 *
 * Features:
 *  1. Right-edge progress bar (turn navigator) pinned to the conversation
 *     column's right edge: one marker per agent turn, real DOM positions,
 *     current-reading-position highlight, hover preview of the turn's first
 *     user question, click to smooth-scroll to that turn.
 *  2. Collapse: per completed turn (hide every row of the turn except the
 *     closing assistant row, which hosts the summary + expand UI) and per
 *     finalized assistant message (hide that row; expand entry aggregates in
 *     the owning turn's summary line). State is in-memory only (per session,
 *     cleared on unmount / plugin stop).
 *
 * DOM dependencies on the shipped chat view (same mechanism the shipped code
 * itself uses for scroll restoration):
 *   - scroll container:  [data-conversation-scroll]
 *   - one row per node:  [data-chat-anchor-key]  (value = stable node key)
 *   - sticky composer:   [data-composer-seat]
 * If any of these disappear, the bar hides and collapse buttons no-op —
 * nothing crashes.
 */
window.__ModuleLoader__.load({
  id: 'dsh-chat-navigator',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    // apply() 中捕获的客户端服务（可选依赖，判空后使用）
    var sessionsService = null
    var workspacesService = null
    var remoteService = null // api-remotes 网关（ctx.remote），V2 拉历史用
    // 硬删除：调用本插件 host 半注册的删除端点（实现移植自 dsh-session-manager，MIT）。
    var managerDeleteAvailable = null // null=未探测
    async function probeManagerDelete() {
      if (managerDeleteAvailable !== null) return managerDeleteAvailable
      try {
        var probe = await fetch('/chat-navigator/api/delete', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: '__probe__' }),
        })
        managerDeleteAvailable = probe.ok // 200 = 端点已注册（未知 id 也返回 ok）
      } catch (e) { managerDeleteAvailable = false }
      return managerDeleteAvailable
    }
    async function deleteSessionViaManager(sessionId) {
      if (!(await probeManagerDelete())) return false
      try {
        var resp = await fetch('/chat-navigator/api/delete', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: sessionId }),
        })
        return resp.ok
      } catch (e) { return false }
    }
    /** 恢复归档：移出全局归档集合（与删除同 host，非破坏性）。 */
    async function unarchiveSessionViaManager(sessionId) {
      try {
        var resp = await fetch('/chat-navigator/api/unarchive', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: sessionId }),
        })
        return resp.ok
      } catch (e) { return false }
    }
    // 分支视觉偏好（localStorage 持久化，均可由用户在分支树面板调整）
    //  forkColor: 自定义主色调 hex 或 null（用主题 --dsw-alias-brand-primary）
    //  baseLevel / maxLevel / glowLevel: 6 挡位索引（0..5）
    var BASE_LEVELS = [15, 30, 45, 60, 75, 90] // 基础强度 %
    var MAX_LEVELS = [55, 64, 73, 82, 91, 100] // 分支最大强度 %
    var GLOW_LEVELS = [0, 3, 5, 7, 10, 14] // 光晕大小 px
    var prefs = { forkColor: null, baseLevel: 2, maxLevel: 5, glowLevel: 2 }
    try {
      var savedColor = window.localStorage.getItem('dsh-chat-navigator.forkColor')
      if (savedColor) prefs.forkColor = savedColor
      var savedBase = parseInt(window.localStorage.getItem('dsh-chat-navigator.baseLevel'), 10)
      if (savedBase >= 0 && savedBase <= 5) prefs.baseLevel = savedBase
      var savedMax = parseInt(window.localStorage.getItem('dsh-chat-navigator.maxLevel'), 10)
      if (savedMax >= 0 && savedMax <= 5) prefs.maxLevel = savedMax
      var savedGlow = parseInt(window.localStorage.getItem('dsh-chat-navigator.glowLevel'), 10)
      if (savedGlow >= 0 && savedGlow <= 5) prefs.glowLevel = savedGlow
    } catch (e) {}
    /** 分支色盘实际使用的品牌色（自定义色优先，否则主题 token）。 */
    function forkBrand() {
      return prefs.forkColor || 'var(--dsw-alias-brand-primary)'
    }
    /** 写一个偏好并持久化 + 通知重渲染。 */
    function setPref(key, value) {
      prefs[key] = value
      try { window.localStorage.setItem('dsh-chat-navigator.' + key, String(value)) } catch (e) {}
      notify()
    }
    /** 恢复全部视觉偏好为默认。 */
    function resetPrefs() {
      prefs.forkColor = null
      prefs.baseLevel = 2
      prefs.maxLevel = 5
      prefs.glowLevel = 2
      try {
        window.localStorage.removeItem('dsh-chat-navigator.forkColor')
        window.localStorage.removeItem('dsh-chat-navigator.baseLevel')
        window.localStorage.removeItem('dsh-chat-navigator.maxLevel')
        window.localStorage.removeItem('dsh-chat-navigator.glowLevel')
        // 清理旧版连续值键（若有）
        window.localStorage.removeItem('dsh-chat-navigator.baseIntensity')
        window.localStorage.removeItem('dsh-chat-navigator.maxIntensity')
        window.localStorage.removeItem('dsh-chat-navigator.glowSize')
      } catch (e) {}
      notify()
    }
    /** 解析主题品牌色为具体 hex（用于颜色选择器显示初始值；无偏好时）。 */
    function resolvedBrandHex() {
      try {
        var v = getComputedStyle(document.documentElement).getPropertyValue('--dsw-alias-brand-primary').trim()
        return v || null
      } catch (e) { return null }
    }

    // ---------------------------------------------------------------- store
    // In-memory state per session: sessionId -> { turns:Set<turn>, messages:Set<messageId>,
    //                                              forks:Map<turn, childId[]>, panel:bool }
    var store = new Map()
    var listeners = new Set()
    var touched = new Set() // DOM rows this plugin hid, restored on plugin stop

    function sessionOf(id) {
      var s = store.get(id)
      if (!s) {
        s = { turns: new Set(), messages: new Set(), forks: new Map(), panel: false }
        store.set(id, s)
      }
      return s
    }
    function notify() {
      listeners.forEach(function (fn) { fn() })
    }
    function subscribe(fn) {
      listeners.add(fn)
      return function () { listeners.delete(fn) }
    }
    function isMessageCollapsed(id, mid) {
      var s = store.get(id)
      return !!s && s.messages.has(mid)
    }
    /** 记录本插件创建的 fork：当前会话某轮 -> 子会话 id。 */
    function recordFork(id, turn, childId) {
      var s = sessionOf(id)
      var list = s.forks.get(turn)
      if (!list) { list = []; s.forks.set(turn, list) }
      if (list.indexOf(childId) < 0) list.push(childId)
      notify()
    }
    function isPanelOpen(id) {
      var s = store.get(id)
      return !!s && s.panel
    }
    function togglePanel(id) {
      var s = sessionOf(id)
      s.panel = !s.panel
      notify()
    }
    function setPanelOpen(id, open) {
      var s = sessionOf(id)
      s.panel = !!open
      notify()
    }
    function toggleTurn(id, turn) {
      var s = sessionOf(id)
      if (s.turns.has(turn)) s.turns.delete(turn); else s.turns.add(turn)
      notify()
    }
    /**
     * 折叠一轮，且保证至少保留一个展开的轮（否则圆点簇会失去可读内容）。
     * 折叠后若所有轮都已折叠：自动展开会话顺序中的下一轮；被折叠的是最后一轮则展开上一轮。
     * @param orderedTurns - 全部轮号，按会话出现顺序排列。
     */
    function collapseTurn(id, turn, orderedTurns) {
      var s = sessionOf(id)
      if (s.turns.has(turn)) return // 已折叠，忽略
      if (orderedTurns.length <= 1) return // 不允许折叠唯一的轮
      var othersExpanded = orderedTurns.filter(function (t) { return t !== turn && !s.turns.has(t) })
      if (othersExpanded.length === 0) {
        var idx = orderedTurns.indexOf(turn)
        var next = idx + 1 < orderedTurns.length ? orderedTurns[idx + 1] : orderedTurns[idx - 1]
        if (next !== undefined && s.turns.has(next)) s.turns.delete(next) // 自动展开下一轮（或上一轮）
      }
      s.turns.add(turn)
      notify()
    }
    function toggleMessage(id, mid) {
      var s = sessionOf(id)
      if (s.messages.has(mid)) s.messages.delete(mid); else s.messages.add(mid)
      notify()
    }
    function clearSession(id) {
      store.delete(id)
    }
    function restoreHidden() {
      touched.forEach(function (el) { el.style.display = '' })
      touched.clear()
    }

    // ------------------------------------------------- V2: 官方 fork 边界推断
    // 官方 fork 的 seedLength 未暴露在客户端 API；通过分页拉父子会话历史做公共前缀对比，
    // 得到「子会话从父会话哪个事件 seq 开始分叉」（= 最后一条相同事件的 seq），再映射到轮次。
    // 分叉边界在创建后永不改变 → 每 (sessionId+childId) 只计算一次并缓存。
    var historySigCache = new Map() // sessionId -> Map<seq, 事件签名>
    var officialForks = new Map() // sessionId -> Map<turn, childId[]>
    var computedBoundary = new Set() // "sessionId:childId"

    /** 事件签名（wire JSON，安全 stringify；去掉 seq/time/type 之外的动态字段保留）。 */
    function eventSig(e) {
      var o = { t: e.type }
      for (var k in e) {
        if (k === 'seq' || k === 'time' || k === 'type') continue
        if (e[k] !== undefined) o[k] = e[k]
      }
      return JSON.stringify(o)
    }
    /** 分页拉取一个会话的完整事件签名表（50 条消息/页，按 beforeSeq 倒推）。 */
    async function fetchSessionSigs(sessionId) {
      var cached = historySigCache.get(sessionId)
      if (cached) return cached
      var sigs = new Map()
      var beforeSeq = undefined
      var guard = 0
      while (remoteService && guard < 300) {
        var resp = await remoteService.sessions.history(sessionId, beforeSeq, 50)
        if (!resp || !resp.ok) break
        var page = resp.value
        if (!page || !page.events || !page.events.length) break
        var minSeq = Infinity
        for (var i = 0; i < page.events.length; i++) {
          var ev = page.events[i] && page.events[i].event
          if (ev && typeof ev.seq === 'number') {
            sigs.set(ev.seq, eventSig(ev))
            if (ev.seq < minSeq) minSeq = ev.seq
          }
        }
        if (!page.hasMore || minSeq === Infinity) break
        beforeSeq = minSeq
        guard++
      }
      historySigCache.set(sessionId, sigs)
      return sigs
    }
    /** 公共前缀对比：返回最后一条父子相同事件的 seq（即 seedLength）。 */
    function computeBoundary(parentSigs, childSigs) {
      var boundary = 0
      childSigs.forEach(function (sig, seq) {
        if (parentSigs.get(seq) === sig && seq > boundary) boundary = seq
      })
      return boundary
    }
    /** 边界 seq -> 轮次：优先精确命中 turnEnds，否则取不大于边界的最远已结束轮。 */
    function turnOfBoundary(turnEnds, boundary) {
      var best = null
      var bestSeq = -1
      turnEnds.forEach(function (endSeq, turn) {
        if (endSeq === boundary) { best = turn; bestSeq = endSeq }
        else if (endSeq < boundary && endSeq > bestSeq) { best = turn; bestSeq = endSeq }
      })
      return best
    }
    /** 计算当前会话直接子会话（官方 fork）的分叉轮次并写入 officialForks。 */
    async function ensureOfficialForks(sessionId, children, turnEnds) {
      if (!remoteService || !children.length || !turnEnds || !turnEnds.size) return
      var parentSigs = await fetchSessionSigs(sessionId)
      var changed = false
      for (var i = 0; i < children.length; i++) {
        var cid = children[i]
        var key = sessionId + ':' + cid
        if (computedBoundary.has(key)) continue
        computedBoundary.add(key)
        try {
          var childSigs = await fetchSessionSigs(cid)
          var boundary = computeBoundary(parentSigs, childSigs)
          var turn = boundary > 0 ? turnOfBoundary(turnEnds, boundary) : null
          if (turn !== null) {
            var m = officialForks.get(sessionId)
            if (!m) { m = new Map(); officialForks.set(sessionId, m) }
            var arr = m.get(turn)
            if (!arr) { arr = []; m.set(turn, arr) }
            if (arr.indexOf(cid) < 0) { arr.push(cid); changed = true }
          }
        } catch (e) {}
      }
      if (changed) notify()
    }
    /** 某轮的全部子会话：插件记录 + 官方推断，去重。 */
    function childrenAt(sessionId, turn) {
      var out = []
      var s = store.get(sessionId)
      if (s && s.forks.get(turn)) out = out.concat(s.forks.get(turn))
      var m = officialForks.get(sessionId)
      if (m && m.get(turn)) out = out.concat(m.get(turn))
      return out.filter(function (v, i, a) { return a.indexOf(v) === i })
    }

    // ------------------------------------------------------- snapshot helpers
    function extractText(data) {
      var parts = []
      function walk(blocks) {
        if (!Array.isArray(blocks)) return
        for (var i = 0; i < blocks.length; i++) {
          var b = blocks[i]
          if (b && (b.type === 'text' || b.kind === 'text') && typeof b.text === 'string' && b.text) {
            parts.push(b.text)
          }
        }
      }
      if (data) {
        walk(data.content)
        walk(data.blocks)
        if (data.closing) {
          walk(data.closing.blocks)
          if (data.closing.finalNode) walk(data.closing.finalNode.blocks)
        }
      }
      return parts.join('\n').replace(/\s+/g, ' ').trim()
    }
    function truncate(s, n) {
      if (!s) return ''
      return s.length <= n ? s : s.slice(0, n) + '…'
    }

    /**
     * Index the chat snapshot by turn.
     * Returns { turns: Map<turn, {turn, anchorKey, keys[], closingKey, hasTool, hasError, summary}>,
     *           messageKey: Map<messageId, nodeKey>,
     *           keyTurn: Map<nodeKey, turn> }.
     */
    function buildTurns(order, nodeStore) {
      var turns = new Map()
      var messageKey = new Map()
      var keyTurn = new Map()
      if (!order || !nodeStore) return { turns: turns, messageKey: messageKey, keyTurn: keyTurn }
      for (var i = 0; i < order.length; i++) {
        var key = order[i]
        var node = nodeStore.get(key)
        if (!node) continue
        var loc = node.location
        var turnNo = loc && (loc.kind === 'turn' || loc.kind === 'step') ? loc.turn.turn : undefined
        if (turnNo !== undefined) {
          keyTurn.set(key, turnNo)
          var t = turns.get(turnNo)
          if (!t) {
            t = { turn: turnNo, anchorKey: key, keys: [], closingKey: null, forkSeq: null, hasTool: false, hasError: false, summary: '' }
            turns.set(turnNo, t)
          }
          t.keys.push(key)
          if (node.kind === 'tool-call') t.hasTool = true
          if (node.kind === 'turn-error' || node.kind === 'turn-max-tokens') t.hasError = true
          if (!t.summary && (node.kind === 'user' || node.kind === 'steering' || node.kind === 'context')) {
            t.summary = truncate(extractText(node.data), 80)
          }
        }
        if (node.kind === 'assistant-step' && node.data && node.data.finalNode && node.data.finalNode.messageId) {
          messageKey.set(node.data.finalNode.messageId, key)
        }
        if (node.kind === 'turn-tail' && node.data) {
          // turn-tail 节点只对「已完成轮」生成：此时该轮可安全 fork。
          var tt = node.data.turn
          var owner = turns.get(tt)
          if (owner) {
            if (node.data.closing && node.data.closing.finalNode) {
              if (node.data.closing.finalNode.messageId) owner.closingKey = messageKey.get(node.data.closing.finalNode.messageId) || null
              if (node.data.closing.finalNode.seq != null) owner.forkSeq = node.data.closing.finalNode.seq
            }
            if (owner.forkSeq == null) owner.forkSeq = node.data.seq != null ? node.data.seq : node.anchorSeq
          }
        }
      }
      // Fallback: a turn whose tail data is unavailable anchors at its last row.
      turns.forEach(function (t) {
        if (!t.closingKey && t.keys.length) t.closingKey = t.keys[t.keys.length - 1]
      })
      return { turns: turns, messageKey: messageKey, keyTurn: keyTurn }
    }

    // -------------------------------------------------------------- DOM utils
    function findScrollport() {
      return document.querySelector('[data-conversation-scroll]')
    }
    function rowsOf(sp) {
      var out = []
      if (!sp) return out
      var all = sp.querySelectorAll('[data-chat-anchor-key]')
      for (var i = 0; i < all.length; i++) out.push(all[i])
      return out
    }
    function rowByKey(sp, key) {
      if (!sp || !key) return null
      var all = sp.querySelectorAll('[data-chat-anchor-key]')
      for (var i = 0; i < all.length; i++) {
        if (all[i].dataset.chatAnchorKey === key) return all[i]
      }
      return null
    }
    function flowTop(row, sp) {
      return row.getBoundingClientRect().top - sp.getBoundingClientRect().top
    }

    // 圆点簇布局常量
    var DOT_SIZE = 8
    var CLUSTER_RATIO = 0.6 // 簇中心相对会话列高度的比例（越大越靠下）
    var WIN_LEN = 6 // 滑动窗口：同时显示的轮次数
    var GLOW_PAD = 24 // 视口四周预留量：覆盖最大光晕(14px) × 悬停放大(1.55) 后的光晕范围，保证 box-shadow 不被矩形视口裁剪

    /** Apply current collapse state to DOM rows (idempotent; no-ops when the DOM contract is absent). */
    function syncCollapse(sessionId, order, nodeStore) {
      var sp = findScrollport()
      if (!sp) return
      var idx = buildTurns(order, nodeStore)
      var s = store.get(sessionId)
      var hidden = new Set()
      if (s) {
        idx.turns.forEach(function (t) {
          if (s.turns.has(t.turn)) {
            for (var i = 0; i < t.keys.length; i++) hidden.add(t.keys[i])
          }
        })
        s.messages.forEach(function (mid) {
          var k = idx.messageKey.get(mid)
          if (k === undefined) return
          var turnNo = idx.keyTurn.get(k)
          var closing = turnNo !== undefined && idx.turns.get(turnNo) ? idx.turns.get(turnNo).closingKey : null
          if (k !== closing) hidden.add(k)
        })
      }
      var rows = rowsOf(sp)
      for (var i = 0; i < rows.length; i++) {
        var key = rows[i].dataset.chatAnchorKey
        var want = hidden.has(key)
        var isHidden = rows[i].style.display === 'none'
        if (want !== isHidden) {
          rows[i].style.display = want ? 'none' : ''
          touched.add(rows[i])
        }
      }
    }

    // ---------------------------------------------------------------- hooks
    /** Re-render whenever the collapse store changes. */
    function useStoreVersion() {
      var v = React.useState(0)
      React.useEffect(function () {
        return subscribe(function () { v[1](function (x) { return x + 1 }) })
      }, [])
      return v[0]
    }

    var btnStyle = {
      background: 'transparent',
      border: '1px solid var(--dsw-alias-border-l1)',
      borderRadius: 4,
      color: 'var(--dsw-alias-label-secondary)',
      fontSize: 11,
      lineHeight: '18px',
      padding: '0 8px',
      cursor: 'pointer',
    }

    // --------------------------------------------------------- progress bar
    function ProgressBar(props) {
      var sessionId = props.sessionId
      var useSession = props.useSession
      var order = useSession(function (s) { return s && s.chat ? s.chat.order : [] })
      var nodes = useSession(function (s) { return s && s.chat ? s.chat.nodes : null })
      var openState = useSession(function (s) { return s ? s.openState : undefined })
      var turnEnds = useSession(function (s) { return s ? s.turnEnds : null })
      var version = useStoreVersion()

      var geomState = React.useState(null)
      var geom = geomState[0]
      var setGeom = geomState[1]
      var hoverState = React.useState(null)
      var hover = hoverState[0]
      var setHover = hoverState[1]
      var clusterRef = React.useRef(null) // 视口元素（滚轮监听 + 当前轮跟随）
      var windowState = React.useState(0)
      var windowStart = windowState[0]
      var setWindowStart = windowState[1]
      var geomMarkersLen = geom ? geom.markers.length : 0
      var currentKey = geom ? geom.current : null
      // 悬停保留期：离开圆点后延迟隐藏，让鼠标有时间移入操作卡片并点击按钮。
      var hideTimerRef = React.useRef(null)
      function scheduleHide() {
        if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
        hideTimerRef.current = setTimeout(function () { setHover(null) }, 200)
      }
      function cancelHide() {
        if (hideTimerRef.current) {
          clearTimeout(hideTimerRef.current)
          hideTimerRef.current = null
        }
      }

      // 分叉交互状态：确认轮 / 忙碌 / 错误文案
      var confirmState = React.useState(null)
      var confirmFork = confirmState[0]
      var setConfirmFork = confirmState[1]
      var busyState = React.useState(false)
      var forkBusy = busyState[0]
      var setForkBusy = busyState[1]
      var errState = React.useState(null)
      var forkError = errState[0]
      var setForkError = errState[1]
      // 会话列表（解析子会话标题）
      var useSessions = props.useSessions
      var sessionList = useSessions(function (s) { return s ? s.byId : {} })
      var useWorkspaces = props.useWorkspaces
      var archivedIds = useWorkspaces(function (s) { return s && s.archivedSessionIds ? s.archivedSessionIds : [] })
      // 当前会话的轮索引（卡片 fork 动作需要 forkSeq）
      var turnIdx = React.useMemo(function () { return buildTurns(order, nodes) }, [order, nodes])

      // Measure + sync collapse on scroll / resize / snapshot / collapse change.
      React.useEffect(function () {
        if (openState !== 'open') {
          setGeom(null)
          return
        }
        var sp = findScrollport()
        if (!sp) {
          setGeom(null)
          return
        }
        var raf = 0
        var disposed = false
        function measure() {
          if (disposed) return
          syncCollapse(sessionId, order, nodes)
          var idx = buildTurns(order, nodes)
          if (!idx.turns.size) {
            setGeom(null)
            return
          }
          var spRect = sp.getBoundingClientRect()
          var s = store.get(sessionId)
          var hasCollapsed = !!s && (s.turns.size > 0 || s.messages.size > 0)
          // 有折叠项时即使滚动高度不足也保留圆点簇（否则全折叠后簇会消失、失去展开入口）
          if (sp.scrollHeight <= sp.clientHeight + 1 && !hasCollapsed) {
            setGeom(null)
            return
          }
          // One marker per turn, in conversation order (no scroll-position mapping).
          var markers = []
          idx.turns.forEach(function (t) {
            markers.push({
              turn: t.turn,
              hasTool: t.hasTool,
              hasError: t.hasError,
              collapsed: !!s && s.turns.has(t.turn),
              forkCount: childrenAt(sessionId, t.turn).filter(function (cid) { return archivedIds.indexOf(cid) < 0 && !!sessionList[cid] }).length,
              forkable: t.forkSeq != null,
              summary: t.summary || ('第 ' + t.turn + ' 轮'),
            })
          })
          // Current reading position: the turn of the first visible anchor row.
          var current = null
          var rows = rowsOf(sp)
          for (var j = 0; j < rows.length; j++) {
            if (rows[j].style.display === 'none') continue
            if (rows[j].getBoundingClientRect().bottom > spRect.top) {
              var k = rows[j].dataset.chatAnchorKey
              var t2 = idx.keyTurn.get(k)
              if (t2 !== undefined) { current = t2; break }
            }
          }
          setGeom({ spRect: spRect, markers: markers, current: current })
        }
        function onScroll() {
          if (raf) return
          raf = requestAnimationFrame(function () { raf = 0; measure() })
        }
        measure()
        sp.addEventListener('scroll', onScroll, { passive: true })
        var ro = typeof ResizeObserver === 'function' ? new ResizeObserver(onScroll) : null
        if (ro) ro.observe(sp)
        window.addEventListener('resize', onScroll)
        return function () {
          disposed = true
          if (raf) cancelAnimationFrame(raf)
          sp.removeEventListener('scroll', onScroll)
          if (ro) ro.disconnect()
          window.removeEventListener('resize', onScroll)
        }
      }, [order, nodes, version, sessionId, openState, archivedIds])

      // V2：推断官方 fork 的分叉轮次（分页历史 + 公共前缀对比），成功后 notify 重渲染标记。
      React.useEffect(function () {
        if (openState !== 'open' || !turnEnds || !turnEnds.size) return
        var s = store.get(sessionId)
        var pluginKids = new Set()
        if (s) s.forks.forEach(function (arr) { arr.forEach(function (cid) { pluginKids.add(cid) }) })
        var children = []
        Object.keys(sessionList).forEach(function (id) {
          var sum = sessionList[id]
          if (sum && sum.parentId === sessionId && sum.origin !== 'subagent' && !pluginKids.has(id)) children.push(id)
        })
        if (!children.length) return
        ensureOfficialForks(sessionId, children, turnEnds).catch(function () {})
      }, [sessionId, turnEnds, sessionList, openState])

      // 在簇上滚轮：滑动窗口（每次 ±1，带动画）。
      React.useEffect(function () {
        var el = clusterRef.current
        if (!el) return
        function onWheel(e) {
          e.preventDefault()
          var delta = e.deltaY > 0 ? 1 : -1
          setWindowStart(function (w) {
            var maxW = Math.max(0, geomMarkersLen - WIN_LEN)
            return Math.max(0, Math.min(maxW, w + delta))
          })
        }
        el.addEventListener('wheel', onWheel, { passive: false })
        return function () { el.removeEventListener('wheel', onWheel) }
      }, [geomMarkersLen])

      // 当前阅读轮变化时，若已不在窗口内则滑动窗口将其纳入（保持在第 4 位附近）。
      React.useEffect(function () {
        if (!geom || geom.current === null) return
        var ci = -1
        for (var k = 0; k < geom.markers.length; k++) {
          if (geom.markers[k].turn === geom.current) { ci = k; break }
        }
        if (ci < 0) return
        setWindowStart(function (w) {
          var maxW = Math.max(0, geom.markers.length - WIN_LEN)
          if (ci >= w && ci < w + WIN_LEN) return w // 已在窗口内，保持用户手滑位置
          return Math.max(0, Math.min(maxW, ci - 3))
        })
      }, [currentKey])

      // 会话切换时【不】清空本插件的会话 store：fork 记录/折叠状态按 sessionId 保留到插件卸载。
      // 否则 fork 成功自动切到子会话时，旧会话清理会删掉刚写入的父会话 fork 记录
      // （分支标记/卡片子会话列表随之失效）。内存 Map 随模块销毁，DOM 隐藏状态由 apply 清理。

      // 卸载时清理悬停隐藏计时器。
      React.useEffect(function () {
        return function () {
          if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
        }
      }, [])

      if (!geom || !geom.markers.length) return null
      // 滑动窗口：固定 WIN_LEN 个槽位，每次仅显示窗口内的轮次；在簇上滚轮即滑动窗口。
      // 全部圆点放在一条平移条中，transform 平移 + CSS transition 实现平滑滑动动画。
      var SLOT = DOT_SIZE + 10 // 每个圆点的槽位宽/高（8px 圆点 + 两侧 5px 热区）
      var count = geom.markers.length
      var winCount = Math.min(count, WIN_LEN)
      var viewportH = winCount * SLOT + GLOW_PAD * 2
      var clusterW = SLOT + GLOW_PAD * 2 // 双侧预留，圆点条居中后左右光晕对称可见
      var anchorY = geom.spRect.top + geom.spRect.height * CLUSTER_RATIO
      var clusterTop = Math.min(Math.max(anchorY - viewportH / 2, geom.spRect.top + 2), geom.spRect.bottom - viewportH - 2)
      var clusterLeft = geom.spRect.right - clusterW - 8
      var maxW = Math.max(0, count - WIN_LEN)
      var ws = Math.max(0, Math.min(windowStart, maxW))
      var orderedTurns = geom.markers.map(function (m) { return m.turn })
      var brandColor = forkBrand() // 统一主色调（自定义或主题品牌色）

      function onMarkerClick(m) {
        if (m.collapsed) toggleTurn(sessionId, m.turn)
        var sp = findScrollport()
        if (!sp) return
        var idx = buildTurns(order, nodes)
        var t = idx.turns.get(m.turn)
        var row = t ? rowByKey(sp, t.anchorKey) : null
        if (!row && t) row = rowByKey(sp, t.closingKey)
        var delay = m.collapsed ? 60 : 0
        setTimeout(function () {
          if (!row || !sp) return
          sp.scrollTo({ top: sp.scrollTop + flowTop(row, sp) - 8, behavior: 'smooth' })
        }, delay)
      }

      /** 卡片内「在此分叉」：fork 该轮 -> 记录 -> 自动打开子会话。 */
      function doFork(m) {
        if (!sessionsService) return
        var t = turnIdx.turns.get(m.turn)
        var seq = t ? t.forkSeq : null
        if (seq == null) { setConfirmFork(null); return }
        setForkBusy(true)
        setForkError(null)
        sessionsService.fork({ sessionId: sessionId, atSeq: seq, increaseTitle: true })
          .then(function (childId) {
            recordFork(sessionId, m.turn, childId)
            setForkBusy(false)
            setConfirmFork(null)
            if (sessionsService) sessionsService.open(childId)
          })
          .catch(function () {
            setForkBusy(false)
            setConfirmFork(null)
            setForkError('分叉失败，请重试')
          })
      }

      var cardStyle = {
        position: 'absolute',
        right: clusterW + 10,
        minWidth: 200,
        maxWidth: 260,
        background: 'var(--dsw-alias-bg-overlay)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 8,
        padding: '8px 10px',
        boxShadow: '0 4px 16px rgba(0,0,0,.2)',
        zIndex: 1300,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        cursor: 'default',
      }
      var cardSummaryStyle = {
        fontSize: 12,
        lineHeight: '16px',
        color: 'var(--dsw-alias-label-primary)',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }
      var cardActionStyle = {
        display: 'flex',
        gap: 6,
      }

      var dots = geom.markers.map(function (m) {
        var forkCount = m.forkCount || 0
        var forkLevel = forkCount > 0 ? Math.min(forkCount, 4) : 0 // 色盘坐标：1..4+
        // 强度梯度（6 挡，用户可调）：无分支=基础强度挡；有分支=基础→最大按分支数内插（1..4）
        var baseI = BASE_LEVELS[prefs.baseLevel]
        var maxI = MAX_LEVELS[prefs.maxLevel]
        function levelFill(c) {
          var pct = baseI + (maxI - baseI) * (c / 4)
          pct = Math.max(0, Math.min(100, Math.round(pct)))
          if (pct >= 100) return brandColor
          return 'color-mix(in srgb, ' + brandColor + ' ' + pct + '%, transparent)'
        }
        var isForked = forkLevel > 0
        var fillColor = isForked
          ? levelFill(forkLevel)
          : 'color-mix(in srgb, ' + brandColor + ' ' + baseI + '%, transparent)'
        var glowPx = GLOW_LEVELS[prefs.glowLevel]
        var isCurrent = geom.current === m.turn
        var isHovered = hover === m.turn
        var dotStyle = {
          width: isCurrent ? DOT_SIZE + 3 : DOT_SIZE,
          height: isCurrent ? DOT_SIZE + 3 : DOT_SIZE,
          borderRadius: '50%',
          cursor: 'pointer',
          transition: 'transform 150ms ease',
        }
        if (isHovered) dotStyle.transform = 'scale(1.55)'
        if (m.collapsed) {
          dotStyle.border = '1px solid ' + brandColor
          dotStyle.background = 'transparent'
          dotStyle.opacity = 0.5
        } else if (isForked) {
          dotStyle.background = fillColor
          dotStyle.border = '1px solid ' + brandColor
          if (glowPx > 0) dotStyle.boxShadow = '0 0 ' + glowPx + 'px color-mix(in srgb, ' + brandColor + ' 60%, transparent)' // 常驻光晕（box-shadow 随悬停缩放、同心）
        } else {
          dotStyle.background = fillColor
        }
        if (isCurrent) dotStyle.boxShadow = '0 0 ' + (glowPx + 1) + 'px ' + brandColor // 当前阅读轮高亮光晕（分叉轮也以更强的当前光晕覆盖）
        // 分支标记：1..4 分支 = 对应条数细横线；5+ 分支 = 一条粗线
        var tickEls = null
        if (isForked) {
          if (forkCount <= 4) {
            var lines = []
            for (var li = 0; li < forkCount; li++) {
              lines.push(React.createElement('div', { key: li, style: { width: 5, height: 1.5, borderRadius: 1, background: brandColor } }))
            }
            tickEls = React.createElement('div', { style: { position: 'absolute', right: 1, bottom: 1, display: 'flex', flexDirection: 'column', gap: 1, pointerEvents: 'none' } }, lines)
          } else {
            tickEls = React.createElement('div', { style: { position: 'absolute', right: 1, bottom: 1, width: 6, height: 4, borderRadius: 1, background: brandColor, pointerEvents: 'none' } })
          }
        }
        return React.createElement('div', {
          key: m.turn,
          style: { position: 'relative', width: SLOT, height: SLOT, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' },
          onMouseEnter: function () { cancelHide(); setConfirmFork(null); setForkError(null); setHover(m.turn) },
          onMouseLeave: scheduleHide,
          onClick: function () { onMarkerClick(m) },
        },
          React.createElement('div', { style: dotStyle }),
          tickEls,
        )
      })

      // 悬停卡片：按窗口内槽位定位（slotIdx = 轮索引 - 窗口起点），渲染在视口（overflow hidden）之外不被裁剪。
      var card = null
      if (hover !== null) {
        var hIdx = -1
        for (var hi = 0; hi < geom.markers.length; hi++) {
          if (geom.markers[hi].turn === hover) { hIdx = hi; break }
        }
        if (hIdx >= 0) {
          var hm = geom.markers[hIdx]
          var slotIdx = hIdx - ws
          if (slotIdx >= 0 && slotIdx < WIN_LEN) {
            var CARD_H = 150 // 卡片可能含分支区/确认区，比纯摘要高
            var cardTop = Math.min(Math.max(GLOW_PAD + slotIdx * SLOT + SLOT / 2 - CARD_H / 2, 2), Math.max(2, viewportH - CARD_H + 30))
            var forkChildren = childrenAt(sessionId, hm.turn).filter(function (cid) { return archivedIds.indexOf(cid) < 0 && !!sessionList[cid] })
            var actions = []
            if (hm.collapsed) {
              actions.push(React.createElement('button', {
                key: 'exp', style: btnStyle,
                onClick: function (e) { e.stopPropagation(); toggleTurn(sessionId, hm.turn) },
              }, '展开本轮'))
            } else if (orderedTurns.length > 1) {
              actions.push(React.createElement('button', {
                key: 'col', style: btnStyle,
                onClick: function (e) { e.stopPropagation(); collapseTurn(sessionId, hm.turn, orderedTurns) },
              }, '折叠本轮'))
            }
            if (hm.forkable) {
              if (confirmFork === hm.turn) {
                actions.push(
                  React.createElement('button', {
                    key: 'fk-y', style: Object.assign({}, btnStyle, { color: 'var(--dsw-alias-brand-primary)' }),
                    disabled: forkBusy,
                    onClick: function (e) { e.stopPropagation(); doFork(hm) },
                  }, forkBusy ? '分叉中…' : '确认分叉'),
                  React.createElement('button', {
                    key: 'fk-n', style: btnStyle,
                    onClick: function (e) { e.stopPropagation(); setConfirmFork(null) },
                  }, '取消'),
                )
              } else {
                actions.push(React.createElement('button', {
                  key: 'fk', style: btnStyle,
                  onClick: function (e) { e.stopPropagation(); setConfirmFork(hm.turn); setForkError(null) },
                }, '在此分叉'))
              }
            }
            var branchRow = null
            if (forkChildren.length > 0) {
              branchRow = React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' } },
                React.createElement('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, '分支 ' + forkChildren.length + '：'),
                forkChildren.map(function (cid) {
                  var title = sessionList[cid] ? (sessionList[cid].displayTitle || cid) : cid
                  return React.createElement('button', {
                    key: cid,
                    style: Object.assign({}, btnStyle, { maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }),
                    title: '打开分支会话：' + title,
                    onClick: function (e) { e.stopPropagation(); if (sessionsService) sessionsService.open(cid) },
                  }, title)
                }),
              )
            }
            var errorRow = forkError
              ? React.createElement('div', { style: { fontSize: 11, color: 'var(--dsw-alias-state-error-primary)' } }, forkError)
              : null
            card = React.createElement('div', {
              style: Object.assign({}, cardStyle, { top: cardTop + 'px' }),
              onMouseEnter: cancelHide,
              onMouseLeave: scheduleHide,
            },
              React.createElement('div', { style: cardSummaryStyle }, (hm.collapsed ? '（已折叠）' : '') + hm.summary),
              React.createElement('div', { style: cardActionStyle }, actions),
              branchRow,
              errorRow,
            )
          }
        }
      }

      return React.createElement('div', {
        style: {
          position: 'fixed',
          zIndex: 1200,
          left: clusterLeft + 'px',
          top: clusterTop + 'px',
          userSelect: 'none',
        },
      },
        React.createElement('div', {
          ref: clusterRef,
          style: { position: 'relative', width: clusterW + 'px', height: viewportH + 'px', overflow: 'hidden' },
        },
          React.createElement('div', {
            style: {
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              transform: 'translateY(' + (GLOW_PAD - ws * SLOT) + 'px)',
              transition: 'transform 260ms cubic-bezier(.42, 0, 1, 1)', // 先慢后快（ease-in）
              willChange: 'transform',
            },
          }, dots),
        ),
        card,
      )
    }

    // ---------------------------------------------------- message collapse UI
    function MessageCollapse(props) {
      var messageId = props.messageId
      var sessionId = props.sessionId
      var useSession = props.useSession
      useStoreVersion()
      var order = useSession(function (s) { return s && s.chat ? s.chat.order : [] })
      var nodes = useSession(function (s) { return s && s.chat ? s.chat.nodes : null })
      var idx = React.useMemo(function () { return buildTurns(order, nodes) }, [order, nodes])
      var key = idx.messageKey.get(messageId)
      if (key === undefined) return null
      var collapsed = isMessageCollapsed(sessionId, messageId)
      return React.createElement('button', {
        style: btnStyle,
        title: '折叠这条助手消息（展开入口在输入区上方的已折叠读条）',
        onClick: function () { toggleMessage(sessionId, messageId) },
      }, collapsed ? '已折叠' : '折叠此消息')
    }

    // --------------------------------------------------- collapsed-turn readout
    /** 常驻读条：列出所有已折叠的轮 / 助手消息，提供逐项与全部展开入口。 */
    function CollapsedReadout(props) {
      var sessionId = props.sessionId
      var useSession = props.useSession
      useStoreVersion()
      var order = useSession(function (s) { return s && s.chat ? s.chat.order : [] })
      var nodes = useSession(function (s) { return s && s.chat ? s.chat.nodes : null })
      var idx = React.useMemo(function () { return buildTurns(order, nodes) }, [order, nodes])
      var s = store.get(sessionId)
      var turns = []
      var messages = []
      if (s) {
        s.turns.forEach(function (turn) {
          var t = idx.turns.get(turn)
          turns.push({ turn: turn, count: t ? t.keys.length : 0 })
        })
        s.messages.forEach(function (mid) {
          var k = idx.messageKey.get(mid)
          if (k === undefined) return
          var turnNo = idx.keyTurn.get(k)
          messages.push({ mid: mid, turn: turnNo !== undefined ? turnNo : null })
        })
      }
      if (!turns.length && !messages.length) return null
      function expandAll() {
        var arr = []
        var ss = store.get(sessionId)
        if (ss) {
          ss.turns.forEach(function (turn) { arr.push(['t', turn]) })
          ss.messages.forEach(function (mid) { arr.push(['m', mid]) })
        }
        for (var i = 0; i < arr.length; i++) {
          if (arr[i][0] === 't') toggleTurn(sessionId, arr[i][1])
          else toggleMessage(sessionId, arr[i][1])
        }
      }
      var chips = turns.map(function (c) {
        return React.createElement('button', {
          key: 't' + c.turn,
          style: btnStyle,
          title: '展开第 ' + c.turn + ' 轮',
          onClick: function () { toggleTurn(sessionId, c.turn) },
        }, '展开第 ' + c.turn + ' 轮' + (c.count > 0 ? '（' + c.count + ' 条）' : ''))
      })
      chips = chips.concat(messages.map(function (m) {
        return React.createElement('button', {
          key: 'm' + m.mid,
          style: btnStyle,
          title: '展开这条助手消息',
          onClick: function () { toggleMessage(sessionId, m.mid) },
        }, '展开助手消息' + (m.turn !== null ? '（第 ' + m.turn + ' 轮）' : ''))
      }))
      if (turns.length + messages.length > 1) {
        chips.push(React.createElement('button', {
          key: 'all',
          style: btnStyle,
          title: '展开全部已折叠内容',
          onClick: expandAll,
        }, '全部展开'))
      }
      return React.createElement('div', {
        style: {
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 6,
          fontSize: 11,
          color: 'var(--dsw-alias-label-secondary)',
          padding: '0 2px',
        },
      },
        React.createElement('span', { style: { opacity: 0.85 } }, '已折叠 ' + (turns.length + messages.length) + ' 项：'),
        chips,
      )
    }

    // ------------------------------------------------------- family tree panel
    /** 从 SessionListState 计算当前会话家族：上溯根后 BFS 收集全部普通 fork 子孙。
     *  archived 中的会话保留但移到其父节点兄弟末尾，并标记 archived（删除线展示）。 */
    function computeFamily(listState, currentId, archivedArr) {
      var byId = listState && listState.byId ? listState.byId : {}
      var archivedSet = {}
      if (archivedArr) archivedArr.forEach(function (id) { archivedSet[id] = true })
      var children = new Map()
      Object.keys(byId).forEach(function (id) {
        var s = byId[id]
        if (s && s.parentId && s.origin !== 'subagent') {
          var arr = children.get(s.parentId)
          if (!arr) { arr = []; children.set(s.parentId, arr) }
          arr.push(id)
        }
      })
      // 兄弟排序：非归档在前、归档移到末尾（组内保持原顺序）
      children.forEach(function (arr) {
        arr.sort(function (a, b) { return (archivedSet[a] ? 1 : 0) - (archivedSet[b] ? 1 : 0) })
      })
      var root = currentId
      var guard = 0
      while (byId[root] && byId[root].parentId && byId[root].origin !== 'subagent' && guard < 100) {
        root = byId[root].parentId
        guard++
      }
      var family = []
      var queue = [[root, 0]]
      var seen = {}
      while (queue.length) {
        var item = queue.shift()
        var id = item[0]
        var depth = item[1]
        if (seen[id]) continue
        seen[id] = true
        family.push({ id: id, depth: depth, archived: !!archivedSet[id] })
        var kids = children.get(id) || []
        for (var i = 0; i < kids.length; i++) queue.push([kids[i], depth + 1])
      }
      return { family: family, children: children }
    }

    var miniBtn = {
      background: 'transparent',
      border: '1px solid var(--dsw-alias-border-l1)',
      borderRadius: 3,
      color: 'var(--dsw-alias-label-secondary)',
      fontSize: 10,
      lineHeight: '14px',
      padding: '0 4px',
      cursor: 'pointer',
    }

    /** 强度挡的内容：按实际强度值填充的品牌色圆点（1→6 由浅到深）。 */
    function colorSwatch(v) {
      return React.createElement('div', {
        style: {
          width: 14, height: 14, borderRadius: '50%',
          background: v >= 100 ? forkBrand() : 'color-mix(in srgb, ' + forkBrand() + ' ' + v + '%, transparent)',
          border: '1px solid color-mix(in srgb, ' + forkBrand() + ' 35%, transparent)',
        },
      })
    }
    /** 光晕挡的内容：大小等于挡位 px 值、带光晕渐变的实心圆点（0 挡显示空心虚线）。 */
    function glowSwatch(v) {
      if (v <= 0) {
        return React.createElement('div', { style: { width: 8, height: 8, borderRadius: '50%', border: '1px dashed var(--dsw-alias-label-secondary)', opacity: 0.5 } })
      }
      var d = Math.max(3, v)
      return React.createElement('div', {
        style: {
          width: d, height: d, borderRadius: '50%',
          background: 'radial-gradient(circle, ' + forkBrand() + ' 40%, color-mix(in srgb, ' + forkBrand() + ' 30%, transparent) 75%, transparent 100%)',
        },
      })
    }
    /** 设置行：标签 + 6 挡按钮（可自定义内容）+ 当前值显示。 */
    function levelRow(label, level, values, unit, onChange, renderContent) {
      return React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
        React.createElement('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', width: 88 } }, label),
        values.map(function (v, i) {
          var active = i === level
          var btnStyle = Object.assign({}, miniBtn, {
            width: 26, height: 26, padding: 0, borderRadius: 6,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }, active ? { border: '1.5px solid ' + forkBrand(), boxShadow: '0 0 3px color-mix(in srgb, ' + forkBrand() + ' 60%, transparent)' } : {})
          return React.createElement('button', {
            key: i,
            style: btnStyle,
            title: v + ' ' + unit,
            onClick: function () { onChange(i) },
          }, renderContent ? renderContent(v, active) : v)
        }),
        React.createElement('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', width: 46, textAlign: 'right' } }, values[level] + ' ' + unit),
      )
    }

    /** 头部常驻按钮 + 家族树浮层面板（无遮罩，ESC/关闭按钮退出）。 */
    function TreePanel(props) {
      var sessionId = props.sessionId
      var useSessions = props.useSessions
      var useWorkspaces = props.useWorkspaces
      useStoreVersion()
      var listState = useSessions(function (s) { return s })
      var archivedIds = useWorkspaces(function (s) { return s && s.archivedSessionIds ? s.archivedSessionIds : [] })
      var open = isPanelOpen(sessionId)

      var confirmState = React.useState(null) // { id, action: 'fork' | 'archive' }
      var confirmNode = confirmState[0]
      var setConfirmNode = confirmState[1]
      var busyState = React.useState(null)
      var busy = busyState[0]
      var setBusy = busyState[1]
      var expandedState = React.useState(function () {
        var set = new Set()
        var byId = listState && listState.byId ? listState.byId : {}
        var node = sessionId
        var guard = 0
        while (node && byId[node] && guard < 100) {
          set.add(node)
          node = byId[node].parentId
          guard++
        }
        return set
      })
      var expanded = expandedState[0]
      var setExpanded = expandedState[1]
      var family = React.useMemo(function () { return computeFamily(listState, sessionId, archivedIds) }, [listState, sessionId, archivedIds])

      // 面板几何跟随会话列（scrollport）
      var geomState = React.useState(null)
      var panelGeom = geomState[0]
      var setPanelGeom = geomState[1]
      React.useEffect(function () {
        if (!open) { setPanelGeom(null); return }
        function measure() {
          var sp = findScrollport()
          if (!sp) { setPanelGeom(null); return }
          var r = sp.getBoundingClientRect()
          setPanelGeom({ top: r.top + 4, height: r.height - 8 })
        }
        measure()
        window.addEventListener('resize', measure)
        return function () { window.removeEventListener('resize', measure) }
      }, [open, sessionId])

      // ESC 关闭
      React.useEffect(function () {
        if (!open) return
        function onKey(e) { if (e.key === 'Escape') setPanelOpen(sessionId, false) }
        window.addEventListener('keydown', onKey)
        return function () { window.removeEventListener('keydown', onKey) }
      }, [open, sessionId])

      function toggleExpand(id) {
        setExpanded(function (prev) {
          var next = new Set(prev)
          if (next.has(id)) next.delete(id); else next.add(id)
          return next
        })
      }
      function doForkNode(id) {
        if (!sessionsService) { setConfirmNode(null); return }
        setBusy('fork')
        sessionsService.fork({ sessionId: id, increaseTitle: true })
          .then(function (childId) {
            setBusy(null)
            setConfirmNode(null)
            if (sessionsService) sessionsService.open(childId)
          })
          .catch(function () { setBusy(null); setConfirmNode(null) })
      }
      function doArchive(id) {
        if (!workspacesService) { setConfirmNode(null); return }
        setBusy('archive')
        workspacesService.archiveSession(id)
          .then(function () {
            setBusy(null)
            setConfirmNode(null)
            if (id === sessionId) setPanelOpen(sessionId, false)
          })
          .catch(function () { setBusy(null); setConfirmNode(null) })
      }
      function doDelete(id) {
        setBusy('delete')
        deleteSessionViaManager(id)
          .then(function (ok) {
            setBusy(null)
            setConfirmNode(null)
            if (ok && id === sessionId) setPanelOpen(sessionId, false)
          })
          .catch(function () { setBusy(null); setConfirmNode(null) })
      }
      // 探测 dsh-session-manager 删除端点是否可用（决定「删除」按钮禁用态）
      var deleteOkState = React.useState(false)
      var deleteOk = deleteOkState[0]
      var setDeleteOk = deleteOkState[1]
      React.useEffect(function () {
        if (!open) return
        probeManagerDelete().then(function (ok) { setDeleteOk(ok) })
      }, [open])

      var byId = listState && listState.byId ? listState.byId : {}
      var rows = family.family.map(function (item) {
        var sum = byId[item.id]
        var title = sum ? (sum.displayTitle || sum.id) : item.id
        var hasKids = (family.children.get(item.id) || []).length > 0
        var isOpen = expanded.has(item.id)
        var isCurrent = item.id === sessionId
        var isRunning = !!sum && !!sum.running
        var isConfirming = confirmNode && confirmNode.id === item.id
        var actions = []
        if (isConfirming) {
          actions.push(
            React.createElement('button', {
              key: 'y', style: Object.assign({}, miniBtn, { color: 'var(--dsw-alias-brand-primary)' }), disabled: !!busy,
              onClick: function (e) {
                e.stopPropagation()
                if (confirmNode.action === 'fork') doForkNode(item.id)
                else if (confirmNode.action === 'archive') doArchive(item.id)
                else doDelete(item.id)
              },
            }, busy === confirmNode.action ? '处理中…' : '确认'),
            React.createElement('button', {
              key: 'n', style: miniBtn,
              onClick: function (e) { e.stopPropagation(); setConfirmNode(null) },
            }, '取消'),
          )
        } else {
          if (!item.archived) {
            actions.push(
              React.createElement('button', {
                key: 'f', style: miniBtn, title: '在该会话尾部分叉（运行中禁用）', disabled: isRunning,
                onClick: function (e) { e.stopPropagation(); setConfirmNode({ id: item.id, action: 'fork' }) },
              }, '分叉'),
              React.createElement('button', {
                key: 'a', style: miniBtn, title: '归档该会话（移到兄弟末尾并显示删除线）',
                onClick: function (e) { e.stopPropagation(); setConfirmNode({ id: item.id, action: 'archive' }) },
              }, '归档'),
            )
          } else {
            actions.push(
              React.createElement('button', {
                key: 'u', style: miniBtn,
                title: deleteOk ? '恢复该会话（移出归档）' : '恢复端点未就绪（host 半未加载？）',
                disabled: !deleteOk,
                onClick: function (e) {
                  e.stopPropagation()
                  unarchiveSessionViaManager(item.id).catch(function () {})
                },
              }, '恢复'),
            )
          }
          actions.push(
            React.createElement('button', {
              key: 'd', style: miniBtn,
              title: deleteOk ? '物理删除该会话（不可恢复）' : '删除端点未就绪（host 半未加载？）',
              disabled: !deleteOk,
              onClick: function (e) { e.stopPropagation(); setConfirmNode({ id: item.id, action: 'delete' }) },
            }, '删除'),
          )
        }
        return React.createElement('div', {
          key: item.id,
          style: {
            padding: '2px 4px',
            paddingLeft: 6 + item.depth * 16,
            background: isCurrent ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
            borderRadius: 4,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 12,
            color: 'var(--dsw-alias-label-primary)',
          },
          onClick: function () { if (sessionsService) sessionsService.open(item.id) },
        },
          React.createElement('span', {
            style: { width: 12, flex: 'none', textAlign: 'center', cursor: hasKids ? 'pointer' : 'default', color: 'var(--dsw-alias-label-secondary)', fontSize: 9 },
            onClick: hasKids ? function (e) { e.stopPropagation(); toggleExpand(item.id) } : undefined,
          }, hasKids ? (isOpen ? '▾' : '▸') : ''),
          React.createElement('span', {
            style: Object.assign({ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, item.archived ? { textDecoration: 'line-through', opacity: 0.65 } : {}),
          }, title),
          isRunning ? React.createElement('span', { style: { width: 6, height: 6, borderRadius: '50%', background: 'var(--dsw-alias-state-warn-primary)', flex: 'none' }, title: '运行中' }) : null,
          isCurrent ? React.createElement('span', { style: { fontSize: 10, color: 'var(--dsw-alias-label-secondary)', flex: 'none' } }, '当前') : null,
          actions,
        )
      })

      var button = React.createElement('button', {
        style: Object.assign({}, btnStyle, open ? { color: 'var(--dsw-alias-brand-primary)', borderColor: 'var(--dsw-alias-brand-primary)' } : {}),
        title: '分支树（当前会话家族）',
        onClick: function () { togglePanel(sessionId) },
      }, '🌳 分支树')

      if (!open) return button
      var panel = React.createElement('div', {
        style: {
          position: 'fixed',
          zIndex: 1300,
          right: 8,
          top: panelGeom ? panelGeom.top + 'px' : 64,
          height: panelGeom ? panelGeom.height + 'px' : 'calc(100vh - 120px)',
          width: 320,
          background: 'var(--dsw-alias-bg-layer-1)',
          border: '1px solid var(--dsw-alias-border-l1)',
          borderRadius: 10,
          boxShadow: '0 8px 32px rgba(0,0,0,.22)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        },
      },
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px', borderBottom: '1px solid var(--dsw-alias-border-l1)' } },
          React.createElement('span', { style: { flex: 1, fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, '分支树'),
          React.createElement('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, family.family.length + ' 个会话'),
          React.createElement('button', { style: btnStyle, onClick: function () { setPanelOpen(sessionId, false) } }, '关闭'),
        ),
        React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, padding: '6px 10px', borderBottom: '1px solid var(--dsw-alias-border-l1)' } },
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
            React.createElement('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', width: 72 } }, '分支主色调'),
            React.createElement('input', {
              type: 'color',
              value: prefs.forkColor || resolvedBrandHex() || '#888888',
              style: { width: 24, height: 20, padding: 0, border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 4, background: 'transparent', cursor: 'pointer' },
              title: '自定义分支色盘主色',
              onChange: function (e) { setPref('forkColor', e.target.value) },
            }),
          ),
          levelRow('基础强度', prefs.baseLevel, BASE_LEVELS, '%', function (v) { setPref('baseLevel', v) }, colorSwatch),
          levelRow('分支最大强度', prefs.maxLevel, MAX_LEVELS, '%', function (v) { setPref('maxLevel', v) }, colorSwatch),
          levelRow('光晕大小', prefs.glowLevel, GLOW_LEVELS, 'px', function (v) { setPref('glowLevel', v) }, glowSwatch),
          React.createElement('button', { style: miniBtn, onClick: resetPrefs, title: '恢复主色/强度/光晕全部默认' }, '恢复默认'),
        ),
        React.createElement('div', { style: { flex: 1, overflowY: 'auto', padding: '6px 4px' } },
          rows.length
            ? rows
            : React.createElement('div', { style: { padding: 16, fontSize: 12, color: 'var(--dsw-alias-label-secondary)', textAlign: 'center' } }, '暂无家族会话'),
        ),
      )
      return React.createElement(React.Fragment, null, button, panel)
    }

    // ------------------------------------------------------------------ entry
    function apply(ctx) {
      var slots = ctx.get('slots')
      if (!slots) return
      sessionsService = ctx.get('sessions') || null
      workspacesService = ctx.get('workspaces') || null
      remoteService = ctx.get('remote') || null
      function register(options, component) {
        var name = options.name
        var opts = {}
        for (var k in options) if (k !== 'name') opts[k] = options[k]
        slots.inject(name, function () {
          return slots.register(Object.assign({ name: name }, opts), component)
        })
      }
      register({
        name: 'conversation.session.header.utilities',
        id: 'chat-navigator',
        order: 100,
      }, function (props) { return React.createElement(ProgressBar, props) })
      register({
        name: 'conversation.session.header.utilities',
        id: 'chat-navigator-tree',
        order: 110,
      }, function (props) { return React.createElement(TreePanel, props) })
      register({
        name: 'conversation.chat.assistant-actions',
        id: 'chat-navigator-collapse-message',
        order: 100,
      }, function (props) { return React.createElement(MessageCollapse, props) })
      register({
        name: 'conversation.composer.dock',
        id: 'chat-navigator-readout',
        order: 100,
      }, function (props) { return React.createElement(CollapsedReadout, props) })
      // Plugin stop / update: restore every row this plugin hid.
      ctx.effect(function () {
        return function () { restoreHidden() }
      })
    }

    exports.apply = apply
    return module.exports
  },
})
