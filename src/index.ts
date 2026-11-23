/**
 * 宿主入口：三条 exact 路由 + 请求门。
 *
 * 路由是「只读状态」「跑三段预检」「触发重启」。请求门有两层：
 * - `connection.requestRejection` 负责 Host/Origin 与浏览器/API 凭据；
 * - `isAllowed` 再要求方法、`x-dsh-restart: 1`、Origin 与 Host 一致。
 * 防止将来开到 LAN 或隧道后面时变成一个远程重启按钮。
 *
 * 运行期只依赖 node 内置模块和宿主已安装的包（这里没引任何 @deepseek-ai/*）：
 * profile 路径从 `ctx.get('profileContext')` 取，连接检查从 `ctx.connection` 取。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import type { LastRecord } from './shared/types'
import { computeFingerprint, isStale, readLast, writeLast } from './server/last'
import { compatFailures, hostRuntimeVersion, readInstalled } from './server/compat'
import { runDumpConfig, runSmoke } from './server/smoke'
import { acquirePrecheck, releasePrecheck, runPrecheckRun } from './server/precheck'
import type { PrecheckIo, PrecheckOutcome, PrecheckTarget } from './server/precheck'
import { RESTART_BUSY_ERROR, armRestart, endRestart, restartGuards, tryBeginRestart } from './server/issue'
import type { RestartIssueIo } from './server/issue'
import { profileOf } from './server/profile'
import { registerTools } from './tools/index'
import {
  PLUGIN_STATUS_PATH,
  RESTART_LOCK_NAME,
  isRefused,
  scheduleRestart,
  waitForPort,
} from './server/restart'

export const name = 'dsh-restart'

/** 只需要 webServer 保证路由能注册；连接服务按需取，缺了 fail-closed。 */
export const inject = ['webServer']

export const STATUS_PATH = PLUGIN_STATUS_PATH
export const PRECHECK_PATH = '/dsh-restart/api/precheck'
export const RESTART_PATH = '/dsh-restart/api/restart'

/** 路由只收自己的两种方法；POST 的两个还各收一种。 */
const ALLOWED_METHODS = new Set(['GET', 'POST'])
/** 跨站请求带不上这个头（会触发预检，而宿主不认 OPTIONS）。 */
const GUARD_HEADER = 'x-dsh-restart'
/** status 探 /health 的预算；正常情况第一次就通。 */
const HEALTH_TIMEOUT_MS = 1_500

export type RouteHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>

/**
 * 这里只声明自己用到的宿主成员，不静态 import cordis 类型：
 * 仓库的 devDependencies 里没有 @deepseek-ai/*，引了会让 tsc 解不到。
 * 结构上要能被宿主真实 Context 满足（register / effect / get / webServer.port）。
 */
export interface RouteContext {
  readonly webServer: {
    readonly port?: number
    register(route: { kind: 'exact'; path: string; handler: RouteHandler }): () => void
  }
  effect(callback: () => void | (() => void), label?: string): void
  get(service: string): unknown
}

/** 路由用到的全部 IO / 时钟；预检/重启那部分与核心模块共用同一份契约。 */
export interface RouteIo extends PrecheckIo, RestartIssueIo {
  probeHealth(port: number): Promise<boolean>
}

export interface Handlers {
  status: RouteHandler
  precheck: RouteHandler
  restart: RouteHandler
}

/** 插件没有配置项。宿主只要求 Standard Schema 的 `~standard.validate`。 */
export const Config = {
  '~standard': {
    version: 1 as const,
    vendor: 'dsh-restart',
    validate(value: unknown) {
      if (value === undefined || value === null) return { value: {} }
      if (typeof value !== 'object' || Array.isArray(value)) {
        return { issues: [{ message: 'dsh-restart 没有配置项，但配置必须是对象' }] }
      }
      if (Object.keys(value).length > 0) {
        return { issues: [{ message: 'dsh-restart 没有配置项，不能带任何配置字段' }] }
      }
      return { value: {} }
    },
  },
}

export interface AllowedInput {
  method: string
  headers: Record<string, string | undefined>
  rejection?: number
}

/**
 * 请求门：rejection 已判定拒绝、方法不是 GET/POST、缺 `x-dsh-restart: 1`、
 * 或 Origin 与 Host 对不上，都不放行。缺 Origin 允许（curl / helper 探针），
 * 但浏览器跨站请求一定带 Origin，对不上就拒。
 */
export function isAllowed(input: AllowedInput): boolean {
  if (input.rejection !== undefined) return false
  if (!ALLOWED_METHODS.has(input.method.toUpperCase())) return false
  if (headerOf(input.headers, GUARD_HEADER) !== '1') return false

  const origin = headerOf(input.headers, 'origin')
  if (origin === undefined) return true
  const host = headerOf(input.headers, 'host')
  if (host === undefined || host === '') return false
  try {
    const parsed = new URL(origin)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    return parsed.host.toLowerCase() === host.toLowerCase()
  } catch {
    return false
  }
}

/** 宿主入口。三条路由分开注册，单条 dispose 也不影响另外两条。 */
export function apply(ctx: RouteContext): void {
  // 路由与工具必须共用同一个 io：互斥状态在核心模块里，但日志目录等
  // 一旦各造一份，两边的「最近一次预检」就不再是同一份。
  const io = defaultIo()
  const handlers = createHandlers(ctx, {}, io)
  const routes: Array<[string, RouteHandler]> = [
    [STATUS_PATH, handlers.status],
    [PRECHECK_PATH, handlers.precheck],
    [RESTART_PATH, handlers.restart],
  ]
  for (const [path, handler] of routes) {
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path, handler }), `dsh-restart: ${path}`)
  }
  // 没有 tools 服务时 registerTools 自己返回 0，不影响三条路由。
  registerTools(ctx, io)
}

/**
 * 路由处理器工厂。第三个参数是已经造好的共享 io；测试仍可只传 overrides，
 * 这时和以前一样在 defaultIo 上覆盖。
 */
export function createHandlers(
  ctx: RouteContext,
  overrides: Partial<RouteIo> = {},
  io: RouteIo = withOverrides(defaultIo(), overrides),
): Handlers {
  // 预检/重启的进程内互斥都在各自的 core 里（acquirePrecheck / tryBeginRestart），
  // 路由与工具共用那一把锁；跨进程仍以 helper 的 restart.lock 为准。

  const status: RouteHandler = async (req, res) => {
    if (!guard(ctx, req, res, 'GET', STATUS_PATH)) return
    const profile = profileOf(ctx)
    if (profile === undefined) {
      respondJson(res, 503, { ok: false, error: '取不到 profileContext，无法判断当前 profile' })
      return
    }

    const port = currentPort(ctx)
    const version = io.runtimeVersion()
    const [record, fingerprint, health, restarting] = await Promise.all([
      safeReadLast(io, io.logDir),
      safeFingerprint(io, profile.dir, version),
      port === undefined ? Promise.resolve(false) : io.probeHealth(port).catch(() => false),
      io.isRefused(join(io.logDir, RESTART_LOCK_NAME)).catch(() => false),
    ])

    // last.json 从未写过也返回 200：helper 拿它当「插件已加载」的第二段判据。
    // 形状约定：顶层缺值显式给 null；last 内部的字段来自 last.json，缺就省略（可能是 {}）。
    respondJson(res, 200, {
      ok: true,
      at: io.now().toISOString(),
      port: port ?? null,
      health,
      stale: isStale(record, fingerprint),
      fingerprint,
      restarting,
      logDir: io.logDir,
      profileName: profile.name,
      last: record,
    })
  }

  const precheck: RouteHandler = async (req, res) => {
    if (!guard(ctx, req, res, 'POST', PRECHECK_PATH)) return
    const profile = profileOf(ctx)
    if (profile === undefined) {
      respondJson(res, 503, { ok: false, error: '取不到 profileContext，无法预检' })
      return
    }
    if (!acquirePrecheck()) {
      // 不排队：排队只会让用户等两轮克隆，第二轮还大概率看到同一份过期结论。
      respondJson(res, 409, { ok: false, error: '已有一轮预检在进行，等它结束再试' })
      return
    }

    try {
      // 锁已经拿到；从这里开始任何一步抛错都由 finally 释放。取消监听也放进 try，
      // 免得 res.once 本身抛错把模块级 running 永久留在 true。
      // 客户端断开就作废这轮结论；进程内没有中断冒烟的可靠办法，只能跑完再丢弃。
      let cancelled = false
      const markCancelled = (): void => {
        if (!res.writableEnded) cancelled = true
      }
      res.once('close', markCancelled)

      res.statusCode = 200
      res.setHeader('content-type', 'application/x-ndjson; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      // 反向代理（如果将来有）默认会攒缓冲；显式关掉，保证阶段行真的逐行出去。
      res.setHeader('x-accel-buffering', 'no')
      try {
        res.flushHeaders()
      } catch {
        // 头已经发出去不算错。
      }

      const write = (payload: unknown): void => {
        // writableEnded 之外还要看 destroyed：客户端断开后底层 socket 已不在，
        // 但 Node 允许 write() 不抛错，这里必须主动停，避免每阶段空写。
        if (res.writableEnded) return
        if ((res as { destroyed?: boolean }).destroyed === true) return
        try {
          res.write(JSON.stringify(payload) + '\n')
        } catch (error) {
          console.error('[dsh-restart] NDJSON 写失败：' + messageOf(error))
        }
      }

      // 取消时补一条 boot 行 + done 行：客户端至少知道这轮没结论，而不是连接莫名其妙断掉。
      const cancelledPayload = (outcome: PrecheckOutcome): void => {
        write({
          stage: 'boot',
          ok: false,
          cancelled: true,
          failures: outcome.failures,
          warnings: [],
          entries: outcome.entries,
          added: [],
          health: outcome.health,
        })
        write({ done: true, ok: false, saved: false, cancelled: true, reason: 'cancelled' })
      }

      try {
        // 取消检查点、逐段进度都在核心模块里；这里只做 NDJSON 映射。
        const outcome = await runPrecheckRun(io, profile, {
          onStage: (stage) => write(stage),
          isCancelled: () => cancelled,
        })
        if (outcome.cancelled) {
          cancelledPayload(outcome)
        } else if (outcome.error !== undefined) {
          write({ done: true, ok: false, saved: false, error: outcome.error })
        } else if (!outcome.saved) {
          // 阶段结论本身是 ok，但没落盘：让客户端用 saved 区分，别只看 ok。
          write({ done: true, ok: outcome.ok, saved: false, reason: 'fingerprint-unavailable' })
        } else {
          write({ done: true, ok: outcome.ok, saved: true, fingerprint: outcome.fingerprint })
        }
      } catch (error) {
        // 核心自己兜异常；这里只兜回调 / 写响应抛出来的那类。
        console.error('[dsh-restart] 预检异常终止：' + messageOf(error))
        write({ done: true, ok: false, saved: false, error: '预检异常终止：' + messageOf(error) })
      }
    } finally {
      // 409 那条分支在加锁前就返回了，这里只负责释放真正跑起来的那一轮。
      releasePrecheck()
      if (!res.writableEnded) {
        try {
          res.end()
        } catch {
          // 客户端已经走了。
        }
      }
    }
  }

  const restart: RouteHandler = async (req, res) => {
    if (!guard(ctx, req, res, 'POST', RESTART_PATH)) return
    if (!tryBeginRestart()) {
      // 进程内先挡一层，别让双击产生两个 helper；跨进程的最终裁决仍看 restart.lock。
      respondJson(res, 409, { ok: false, error: RESTART_BUSY_ERROR })
      return
    }
    // 客户端可能在 isRefused 挂起期间就断开；先记录，等判定完再决定怎么收尾。
    // 不能在这里 endRestart：否则第一个请求还没派生 helper，第二个请求就能挤进来。
    let clientGone = false
    res.once('close', () => {
      clientGone = true
    })

    try {
      const profile = profileOf(ctx)
      const port = currentPort(ctx)
      const gate = await restartGuards(io, profile, port)
      if (!gate.ok) {
        endRestart()
        respondJson(res, gate.status, { ok: false, error: gate.error })
        return
      }
      // 守卫已经证明两者都在（喂进去的就是这两份值）；返回类型不带收窄，这里断言一次。
      const target = profile as PrecheckTarget
      const listenPort = port as number

      const at = io.now().toISOString()
      let armed = false
      const arm = (): void => {
        if (armed) return
        armed = true
        // 响应已落 socket 才派生 helper；不在响应前拍脑袋延迟。
        armRestart(io, target, listenPort)
      }

      // 'finish' 正常路径；'close' 兜底客户端在 202 落盘前就断开的情况。arm 幂等。
      res.once('finish', arm)
      res.once('close', arm)
      res.once('close', endRestart)
      res.statusCode = 202
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      const body = JSON.stringify({
        ok: true,
        at,
        port: listenPort,
        logDir: io.logDir,
        profileName: target.name,
      })
      if (clientGone) {
        // close 早于上面的监听挂载：事件不会再触发，手动补 arm + endRestart，别留下永久 409。
        arm()
        endRestart()
        try {
          res.end(body)
        } catch {
          // 客户端已经走了。
        }
        return
      }
      res.end(body)
    } catch (error) {
      endRestart()
      if (!res.headersSent) {
        respondJson(res, 500, { ok: false, error: '重启请求处理失败：' + messageOf(error) })
      } else {
        try {
          res.end()
        } catch {
          // 客户端先断了。
        }
      }
    }
  }

  return { status, precheck, restart }
}

function defaultIo(): RouteIo {
  return {
    now: () => new Date(),
    readLast,
    writeLast,
    computeFingerprint,
    runtimeVersion: () => {
      const version = hostRuntimeVersion()
      return version.trim() === '' ? null : version
    },
    probeHealth: (port) => waitForPort(port, HEALTH_TIMEOUT_MS),
    runDumpConfig,
    readInstalled: (profileDir, onWarning) =>
      readInstalled(profileDir, onWarning === undefined ? undefined : { onWarning }),
    compatFailures,
    runSmoke: (options) => runSmoke(options),
    scheduleRestart,
    isRefused,
    tmpRoot: join(tmpdir(), 'dsh-restart-smoke'),
    logDir: process.env.DSH_RESTART_LOG_DIR?.trim() || join(homedir(), '.dsh', 'dsh-restart'),
  }
}

function withOverrides(base: RouteIo, overrides: Partial<RouteIo>): RouteIo {
  const merged: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(overrides)) {
    // 只覆盖显式传了的键；测试里 partial 的其余键保持生产默认。
    if (value !== undefined) merged[key] = value
  }
  return merged as unknown as RouteIo
}

function currentPort(ctx: RouteContext): number | undefined {
  try {
    const port = ctx.webServer.port
    return typeof port === 'number' && Number.isFinite(port) && port > 0 ? port : undefined
  } catch {
    return undefined
  }
}

interface ConnectionLike {
  requestRejection(request: IncomingMessage): number | undefined
}

function connectionOf(ctx: RouteContext): ConnectionLike | undefined {
  // cordis 的插件 ctx 在未声明 inject 'connection' 时，属性访问会直接抛
  // 'cannot get property "connection" without inject'；ctx.get 才是免 inject 的正规取法。
  // 先走 get，再把属性访问单独兜底：不能把两者放进同一个 try，否则属性访问一抛就跳过了 get。
  try {
    const viaGet = ctx.get('connection')
    if (isConnection(viaGet)) return viaGet
  } catch {
    // get 也不可用时继续试属性访问。
  }
  try {
    const direct: unknown = Reflect.get(ctx, 'connection')
    if (isConnection(direct)) return direct
  } catch {
    // 服务还没挂上：按拒绝处理。
  }
  return undefined
}

function isConnection(value: unknown): value is ConnectionLike {
  return isRecord(value) && typeof value.requestRejection === 'function'
}

/**
 * undefined = 放行；数字 = 宿主给出的拒绝状态码；服务缺失时自己补一个 503。
 * 这里故意不用 403：403 代表「宿主明确拒绝」，503 代表「本插件取不到连接服务」，
 * 两者在排障时含义不同（约束里写的 403 是「请求被拒」的兜底，不是服务未挂载）。
 */
function rejectionOf(ctx: RouteContext, req: IncomingMessage): number | undefined {
  const connection = connectionOf(ctx)
  if (connection === undefined) return 503
  try {
    const rejection = connection.requestRejection(req)
    return typeof rejection === 'number' ? rejection : undefined
  } catch {
    return 403
  }
}

/**
 * helper 重启后的就绪探针没有浏览器 Cookie，`requestRejection` 会给 401。
 * 只对「本机回环 + 恰好是 GET /dsh-restart/api/status + 带 x-dsh-restart + 无 Origin」放行；
 * 写操作（precheck/restart）永远不享受这个例外。
 *
 * 威胁模型（F3 的遗留）：这个例外看的是 remoteAddress。若本机有反向代理/隧道
 * （cloudflared、frp、nginx -> 127.0.0.1:3080）且把 Host 也改写成回环地址，
 * 外部未认证请求会继承回环来源。这里额外拒绝带 x-forwarded-for / forwarded 的请求，
 * 能挡住常见代理，但挡不住主动剥头的代理。彻底做法是 helper 与宿主共享一个令牌文件，
 * 或另开一个只回 204 的 /ready 路由（需要 Task 5 配合，本轮不动 helper）。
 */
function isLocalReadinessProbe(req: IncomingMessage, expected: 'GET' | 'POST', routePath: string): boolean {
  if (routePath !== STATUS_PATH) return false
  if (expected !== 'GET') return false
  if ((req.method ?? '').toUpperCase() !== 'GET') return false
  if (pathOf(req.url) !== STATUS_PATH) return false
  const headers = headersRecord(req.headers)
  if (headerOf(headers, GUARD_HEADER) !== '1') return false
  if (headerOf(headers, 'origin') !== undefined) return false
  if (headerOf(headers, 'x-forwarded-for') !== undefined) return false
  if (headerOf(headers, 'forwarded') !== undefined) return false
  const host = headerOf(headers, 'host')
  if (host === undefined || !isLoopbackAuthority(host)) return false
  const address = req.socket?.remoteAddress
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function isLoopbackAuthority(authority: string): boolean {
  try {
    const hostname = new URL('http://' + authority).hostname.replace(/^\[|\]$/g, '').toLowerCase()
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1'
  } catch {
    return false
  }
}

function pathOf(url: string | undefined): string {
  const raw = url ?? ''
  const query = raw.indexOf('?')
  return query === -1 ? raw : raw.slice(0, query)
}

function guard(
  ctx: RouteContext,
  req: IncomingMessage,
  res: ServerResponse,
  expected: 'GET' | 'POST',
  routePath: string,
): boolean {
  let rejection = rejectionOf(ctx, req)
  if (rejection === 401 && isLocalReadinessProbe(req, expected, routePath)) rejection = undefined
  if (!isAllowed({ method: req.method ?? '', headers: headersRecord(req.headers), rejection })) {
    respondJson(res, rejection ?? 403, { ok: false, error: '请求未通过来源检查' })
    return false
  }
  if ((req.method ?? '').toUpperCase() !== expected) {
    respondJson(res, 403, { ok: false, error: `该路由只收 ${expected}` })
    return false
  }
  return true
}

function headersRecord(headers: IncomingMessage['headers']): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === 'string') out[name.toLowerCase()] = value
    else if (Array.isArray(value)) out[name.toLowerCase()] = value.join(',')
  }
  return out
}

function headerOf(headers: Record<string, string | undefined>, name: string): string | undefined {
  const direct = headers[name]
  if (direct !== undefined) return direct
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value
  }
  return undefined
}

async function safeReadLast(io: RouteIo, dir: string): Promise<LastRecord> {
  try {
    return await io.readLast(dir)
  } catch {
    return {}
  }
}

async function safeFingerprint(io: RouteIo, profileDir: string, version: string | null): Promise<string | null> {
  try {
    return await io.computeFingerprint(profileDir, version)
  } catch {
    return null
  }
}

function respondJson(res: ServerResponse, status: number, payload: unknown): void {
  try {
    if (res.writableEnded) return
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(payload))
  } catch (error) {
    console.error('[dsh-restart] 响应失败：' + messageOf(error))
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}