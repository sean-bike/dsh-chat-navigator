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

    // ---------------------------------------------------------------- store
    // In-memory collapse state per session: sessionId -> { turns:Set<turn>, messages:Set<messageId> }
    var store = new Map()
    var listeners = new Set()
    var touched = new Set() // DOM rows this plugin hid, restored on plugin stop

    function sessionOf(id) {
      var s = store.get(id)
      if (!s) {
        s = { turns: new Set(), messages: new Set() }
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
            t = { turn: turnNo, anchorKey: key, keys: [], closingKey: null, hasTool: false, hasError: false, summary: '' }
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
        if (node.kind === 'turn-tail' && node.data && node.data.closing && node.data.closing.finalNode && node.data.closing.finalNode.messageId) {
          var ck = messageKey.get(node.data.closing.finalNode.messageId)
          var tt = node.data.turn
          var owner = turns.get(tt)
          if (owner) owner.closingKey = ck || null
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
      }, [order, nodes, version, sessionId, openState])

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

      // Drop per-session state when the session view unmounts.
      React.useEffect(function () {
        return function () { clearSession(sessionId) }
      }, [sessionId])

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
      var GLOW_PAD = 12 // 视口四周预留光晕余量，避免当前轮阴影（悬停放大时更大）被矩形视口截断
      var count = geom.markers.length
      var winCount = Math.min(count, WIN_LEN)
      var viewportH = winCount * SLOT + GLOW_PAD * 2
      var clusterW = SLOT + GLOW_PAD
      var anchorY = geom.spRect.top + geom.spRect.height * CLUSTER_RATIO
      var clusterTop = Math.min(Math.max(anchorY - viewportH / 2, geom.spRect.top + 2), geom.spRect.bottom - viewportH - 2)
      var clusterLeft = geom.spRect.right - clusterW - 8
      var maxW = Math.max(0, count - WIN_LEN)
      var ws = Math.max(0, Math.min(windowStart, maxW))
      var orderedTurns = geom.markers.map(function (m) { return m.turn })

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
        var color = 'var(--dsw-alias-label-secondary)'
        if (!m.collapsed && m.hasError) color = 'var(--dsw-alias-state-error-primary)'
        else if (!m.collapsed && m.hasTool) color = 'var(--dsw-alias-brand-primary)'
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
          dotStyle.border = '1px solid ' + color
          dotStyle.background = 'transparent'
          dotStyle.opacity = 0.5
        } else {
          dotStyle.background = color
          if (isCurrent) dotStyle.boxShadow = '0 0 4px ' + color
        }
        return React.createElement('div', {
          key: m.turn,
          style: { width: SLOT, height: SLOT, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' },
          onMouseEnter: function () { cancelHide(); setHover(m.turn) },
          onMouseLeave: scheduleHide,
          onClick: function () { onMarkerClick(m) },
        }, React.createElement('div', { style: dotStyle }))
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
            var CARD_H = 120
            var cardTop = Math.min(Math.max(GLOW_PAD + slotIdx * SLOT + SLOT / 2 - CARD_H / 2, 2), Math.max(2, viewportH - CARD_H + 30))
            card = React.createElement('div', {
              style: Object.assign({}, cardStyle, { top: cardTop + 'px' }),
              onMouseEnter: cancelHide,
              onMouseLeave: scheduleHide,
            },
              React.createElement('div', { style: cardSummaryStyle }, (hm.collapsed ? '（已折叠）' : '') + hm.summary),
              React.createElement('div', { style: cardActionStyle },
                hm.collapsed
                  ? React.createElement('button', {
                      style: btnStyle,
                      onClick: function (e) { e.stopPropagation(); toggleTurn(sessionId, hm.turn) },
                    }, '展开本轮')
                  : (orderedTurns.length > 1
                      ? React.createElement('button', {
                          style: btnStyle,
                          onClick: function (e) {
                            e.stopPropagation()
                            collapseTurn(sessionId, hm.turn, orderedTurns)
                          },
                        }, '折叠本轮')
                      : null),
                React.createElement('button', {
                  style: btnStyle,
                  onClick: function (e) { e.stopPropagation(); onMarkerClick(hm) },
                }, '跳转'),
              ),
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

    // ------------------------------------------------------------------ entry
    function apply(ctx) {
      var slots = ctx.get('slots')
      if (!slots) return
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
