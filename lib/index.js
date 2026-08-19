/**
 * dsh-chat-navigator — Host half（含会话物理删除能力）。
 *
 * 删除实现移植自 dsh-session-manager（MIT，https://github.com/hkkz9522/dsh-session-manager），
 * 仅保留 delete 分支并改用本插件自己的路由前缀：
 *
 *   POST /chat-navigator/api/delete  { sessionId }
 *     物理删除一个会话：取消/释放运行中的 agent、摘除 session store 条目（触发
 *     session/disposed → host/session-removed，所有标签页移除该行）、flush 并删除
 *     JSONL 产物目录、清理工作区记账与归档集合。全部变更走 workspace registry 的
 *     enqueueOperation + setState 持久化路径，重启不会复活已删除会话。
 *   POST /chat-navigator/api/unarchive  { sessionId }
 *     将会话移出全局归档集合（恢复）；registry 的 domain/changed → host/archived-sessions-changed
 *     帧会自动刷新所有客户端。
 *
 * 其余功能（圆点导航/折叠/分叉/家族树）均为纯 client 实现。
 */
import { rm } from 'node:fs/promises'
import { dirname } from 'node:path'

export const name = 'dsh-chat-navigator'

export const inject = [
  'webServer',
  'workspaceRegistry',
  'sessions',
  'agents',
  'sessionPersistence',
]

const API_PREFIX = '/chat-navigator/api'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function apply(ctx) {
  const readBody = async (req) => {
    const chunks = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    return Buffer.concat(chunks).toString('utf8')
  }

  const send = (res, code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(obj))
  }

  /** Remove one id from the registry-global archive set (durable, serialized). */
  const unarchiveSession = async (sessionId) => {
    const registry = ctx.workspaceRegistry
    await registry.enqueueOperation(async () => {
      const state = registry.requireState()
      if (!state.archivedSessionIds.includes(sessionId)) return
      await registry.setState({
        ...state,
        archivedSessionIds: state.archivedSessionIds.filter((id) => id !== sessionId),
      })
    })
  }

  /** Detach one session from every workspace's ordered accounting. */
  const detachFromWorkspaces = async (sessionId) => {
    for (const entity of ctx.workspaceRegistry.list()) {
      if (entity.sessionIds.includes(sessionId)) {
        await entity.detachSession(sessionId)
      }
    }
  }

  /** Resolve the on-disk session directory (parent of its artifact), if any. */
  const sessionDirOf = async (sessionId) => {
    const persistence = ctx.get('sessionPersistence')
    if (persistence === void 0) return void 0
    const headers = await persistence.list()
    const meta = headers.find((header) => header.id === sessionId)
    if (meta === void 0) return void 0
    const location = persistence.locate(meta)
    if (location === void 0) return void 0
    return dirname(location.path)
  }

  /** 读取一个会话的全部事件：活跃会话直接取，冷会话从持久化读取。 */
  const readSessionEvents = async (sessionId) => {
    const session = ctx.sessions.get(sessionId)
    if (session !== void 0) return session.events
    const persistence = ctx.get('sessionPersistence')
    if (persistence === void 0) return null
    try {
      const stored = await persistence.loadStored(sessionId)
      return stored ? stored.events : null
    } catch {
      return null
    }
  }

  /** 事件内容签名（剥离 seq/time/type；wire JSON 可直接比较）。 */
  const eventSig = (event) => {
    const out = { t: event.type }
    for (const key of Object.keys(event)) {
      if (key === 'seq' || key === 'time' || key === 'type') continue
      if (event[key] !== undefined) out[key] = event[key]
    }
    return JSON.stringify(out)
  }

  /** 递归提取事件文本（用于用户消息摘要）。 */
  const summaryText = (value, depth) => {
    if (depth > 5 || value == null) return ''
    if (typeof value === 'string') return value
    if (Array.isArray(value)) return value.map((v) => summaryText(v, depth + 1)).filter(Boolean).join(' ')
    if (typeof value !== 'object') return ''
    if (typeof value.text === 'string') return value.text
    const picks = [value.content, value.message && value.message.content, value.data && value.data.content, value.parts]
    for (const pick of picks) {
      const out = summaryText(pick, depth + 1)
      if (out) return out
    }
    return ''
  }

  /** 从事件流组装轮次摘要。 */
  const buildSummaryTurns = (events) => {
    const turns = []
    let current = null
    let ordinal = 0
    for (const event of events) {
      if (!event || !event.type) continue
      const type = event.type
      if (type === 'turn/start') {
        ordinal++
        current = { turn: typeof event.turn === 'number' ? event.turn : ordinal, time: event.time, summary: '', hasTool: false, hasError: false }
      } else if (type === 'user/message') {
        if (!current) { ordinal++; current = { turn: ordinal, time: event.time, summary: '', hasTool: false, hasError: false } }
        if (!current.summary) current.summary = summaryText(event.content || event.message || event.data || event, 0).slice(0, 80)
      } else if (type.indexOf('tool/') === 0 || type === 'tool/call' || type === 'tool/result') {
        if (current) current.hasTool = true
      } else if (type === 'turn/error' || type === 'turn/max-tokens' || type === 'agent/error') {
        if (current) current.hasError = true
      } else if (type === 'turn/end') {
        if (!current) { ordinal++; current = { turn: ordinal, time: event.time, summary: '', hasTool: false, hasError: false } }
        if (typeof event.turn === 'number') current.turn = event.turn
        turns.push(current)
        current = null
      }
    }
    if (current) turns.push(current)
    return turns
  }

  /**
   * Delete one session end to end. Returns a summary of what was torn down.
   * Idempotent-ish: unknown sessions resolve to { ok: true, deleted: false }.
   */
  const deleteSession = async (sessionId) => {
    const session = ctx.sessions.get(sessionId)
    const agent = ctx.agents.get(sessionId)

    if (agent !== void 0) {
      // Stop any running turn (disposed-kind suppresses re-wake).
      agent.cancel({ kind: 'disposed' })
      // Quiesce the agent's own fiber (idempotent; bounded in case teardown stalls).
      if (typeof agent.scope?.dispose === 'function') {
        await Promise.race([agent.scope.dispose(), sleep(3000)])
      }
      // Drop the zombie from the registry so a later session.create/open with
      // the same id cannot resurrect it.
      try {
        ctx.agents.store?.delete?.(sessionId)
      } catch { /* best-effort */ }
    }

    if (session !== void 0) {
      // Flush buffered events to disk first so the retirement drain is a no-op.
      try {
        await ctx.sessions.flush(session)
      } catch { /* best-effort */ }
      // Detach the session store entry: emits session/disposed, which the
      // persistence write-path answers with a final drain, and the API proxy
      // relays as host/session-removed so every connected client drops the row.
      try {
        const entry = ctx.sessions.store?.get?.(sessionId)
        if (entry !== void 0 && typeof entry.detach === 'function') {
          entry.detach()
          await sleep(200) // let the write-behind retirement settle
        }
      } catch { /* best-effort */ }
    }

    // Workspace accounting + archive-set membership.
    await detachFromWorkspaces(sessionId)
    await unarchiveSession(sessionId)

    // Physical artifact (session.jsonl / session.jsonl.zstd) + any extras.
    const dir = await sessionDirOf(sessionId)
    if (dir !== void 0) {
      await rm(dir, { recursive: true, force: true })
    }

    return {
      ok: true,
      sessionId,
      wasLive: session !== void 0 || agent !== void 0,
      filesRemoved: dir !== void 0,
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const path = url.pathname.startsWith(API_PREFIX)
          ? url.pathname.slice(API_PREFIX.length) || '/'
          : '/'
        let body = {}
        if (req.method === 'POST') {
          const raw = await readBody(req)
          if (raw.trim() !== '') {
            try {
              body = JSON.parse(raw)
            } catch {
              return send(res, 400, { ok: false, error: '请求体不是合法 JSON' })
            }
          }
        }
        const sessionId = typeof body.sessionId === 'string' && body.sessionId.trim() !== ''
          ? body.sessionId.trim()
          : null

        if (req.method === 'POST' && path === '/delete') {
          if (sessionId === null) return send(res, 400, { ok: false, error: 'sessionId 必填' })
          try {
            const result = await deleteSession(sessionId)
            return send(res, 200, { ok: true, result })
          } catch (error) {
            ctx.logger.warn(`dsh-chat-navigator: delete "${sessionId}" failed: ${String(error)}`)
            return send(res, 500, { ok: false, error: String(error instanceof Error ? error.message : error) })
          }
        }

        if (req.method === 'POST' && path === '/unarchive') {
          if (sessionId === null) return send(res, 400, { ok: false, error: 'sessionId 必填' })
          try {
            await unarchiveSession(sessionId)
            return send(res, 200, { ok: true, result: { sessionId } })
          } catch (error) {
            ctx.logger.warn(`dsh-chat-navigator: unarchive "${sessionId}" failed: ${String(error)}`)
            return send(res, 500, { ok: false, error: String(error instanceof Error ? error.message : error) })
          }
        }

        if (req.method === 'POST' && path === '/summary') {
          if (sessionId === null) return send(res, 400, { ok: false, error: 'sessionId 必填' })
          try {
            const events = await readSessionEvents(sessionId)
            return send(res, 200, { ok: true, result: { turns: events ? buildSummaryTurns(events) : [] } })
          } catch (error) {
            ctx.logger.warn(`dsh-chat-navigator: summary "${sessionId}" failed: ${String(error)}`)
            return send(res, 500, { ok: false, error: String(error instanceof Error ? error.message : error) })
          }
        }

        if (req.method === 'POST' && path === '/sigs') {
          if (sessionId === null) return send(res, 400, { ok: false, error: 'sessionId 必填' })
          try {
            const events = await readSessionEvents(sessionId)
            const rows = (events || []).map((event) => [event.seq, eventSig(event)])
            return send(res, 200, { ok: true, result: { rows } })
          } catch (error) {
            ctx.logger.warn(`dsh-chat-navigator: sigs "${sessionId}" failed: ${String(error)}`)
            return send(res, 500, { ok: false, error: String(error instanceof Error ? error.message : error) })
          }
        }

        return send(res, 404, { ok: false, error: `not found: ${req.method} ${path}` })
      } catch (error) {
        ctx.logger.warn(`dsh-chat-navigator: api error: ${String(error)}`)
        return send(res, 500, { ok: false, error: String(error instanceof Error ? error.message : error) })
      }
    },
  }), 'dsh-chat-navigator: http api')
}
