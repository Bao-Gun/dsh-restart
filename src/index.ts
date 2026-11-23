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
import { basename, dirname, join } from 'node:path'

import type { Failure, LastRecord, PrecheckResult } from './shared/types'
import { computeFingerprint, isStale, readLast, writeLast } from './server/last'
import { compatFailures, hostRuntimeVersion, readInstalled } from './server/compat'
import type { InstalledPlugin } from './server/compat'
import { diffFailedEntries, runDumpConfig, runSmoke } from './server/smoke'
import type { SmokeResult } from './server/smoke'
import {
  PLUGIN_STATUS_PATH,
  RESTART_LOCK_NAME,
  isRefused,
  scheduleRestart,
  waitForPort,
} from './server/restart'
import type { ScheduleRestartOptions } from './server/restart'

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

/** 路由用到的全部 IO / 时钟。测试注入假实现，生产走 defaultIo()。 */
export interface RouteIo {
  now(): Date
  readLast(dir: string): Promise<LastRecord>
  writeLast(dir: string, patch: Partial<LastRecord>): Promise<void>
  computeFingerprint(profileDir: string, dshVersion: string | null): Promise<string | null>
  runtimeVersion(): string | null
  probeHealth(port: number): Promise<boolean>
  runDumpConfig(profileDir: string): Promise<Failure[]>
  readInstalled(profileDir: string, onWarning?: (failure: Failure) => void): Promise<InstalledPlugin[]>
  compatFailures(plugins: InstalledPlugin[], runtimeVersion: string): Failure[]
  runSmoke(options: { profileDir: string; tmpRoot: string }): Promise<SmokeResult>
  scheduleRestart(options: ScheduleRestartOptions): void
  isRefused(lockPath: string): Promise<boolean>
  tmpRoot: string
  logDir: string
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
  const handlers = createHandlers(ctx)
  const routes: Array<[string, RouteHandler]> = [
    [STATUS_PATH, handlers.status],
    [PRECHECK_PATH, handlers.precheck],
    [RESTART_PATH, handlers.restart],
  ]
  for (const [path, handler] of routes) {
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path, handler }), `dsh-restart: ${path}`)
  }
}

export function createHandlers(ctx: RouteContext, overrides: Partial<RouteIo> = {}): Handlers {
  const io = withOverrides(defaultIo(), overrides)

  const status: RouteHandler = async (req, res) => {
    if (!guard(ctx, req, res, 'GET')) return
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
    respondJson(res, 200, {
      ok: true,
      at: io.now().toISOString(),
      port: port ?? null,
      health,
      stale: isStale(record, fingerprint),
      fingerprint,
      restarting,
      last: record,
    })
  }

  const precheck: RouteHandler = async (req, res) => {
    if (!guard(ctx, req, res, 'POST')) return
    const profile = profileOf(ctx)
    if (profile === undefined) {
      respondJson(res, 503, { ok: false, error: '取不到 profileContext，无法预检' })
      return
    }

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

    const startedAt = Date.now()
    const write = (payload: unknown): void => {
      if (res.writableEnded) return
      try {
        res.write(JSON.stringify(payload) + '\n')
      } catch (error) {
        console.error('[dsh-restart] NDJSON 写失败：' + messageOf(error))
      }
    }

    try {
      // 快检 A：配置合成本身会不会挂。
      const configFailures = await stage('config', () => io.runDumpConfig(profile.dir))
      write({ stage: 'config', ok: configFailures.length === 0, failures: configFailures })

      // 快检 B：装着的插件跟当前 dsh 版本兼不兼容。清单告警也算失败，不能静默放行。
      const version = io.runtimeVersion()
      const warnings: Failure[] = []
      let compat: Failure[] = []
      try {
        const plugins = await io.readInstalled(profile.dir, (failure) => warnings.push(failure))
        compat = [...warnings, ...io.compatFailures(plugins, version ?? '')]
      } catch (error) {
        compat = [...warnings, { kind: 'compat', message: '兼容性检查失败：' + messageOf(error) }]
      }
      write({ stage: 'compat', ok: compat.length === 0, failures: compat })

      // 快检 C：克隆 profile 真起一个实例，收未激活名单并跟基线差分。
      let smoke: SmokeResult
      try {
        smoke = await io.runSmoke({ profileDir: profile.dir, tmpRoot: io.tmpRoot })
      } catch (error) {
        smoke = {
          ok: false,
          health: false,
          failures: [{ kind: 'boot', message: '冒烟执行失败：' + messageOf(error) }],
          failedEntries: [],
          durationMs: 0,
        }
      }
      const previous = await safeReadLast(io, io.logDir)
      const { added } = diffFailedEntries(smoke.failedEntries, previous.baseline ?? [])
      const addedFailures: Failure[] = added.map((entry) => ({
        plugin: entry,
        kind: 'boot',
        message: `${entry} 在试跑里没有激活，而且不在上次通过的基线里`,
      }))
      const bootFailures = [...smoke.failures, ...addedFailures]
      // runSmoke.ok 已包含 health 200 与「临时目录 / 进程组清理干净」；新增失败再看差分。
      const bootOk = smoke.ok && added.length === 0
      write({
        stage: 'boot',
        ok: bootOk,
        failures: bootFailures,
        entries: smoke.failedEntries,
        added,
        health: smoke.health,
      })

      const ok = configFailures.length === 0 && compat.length === 0 && bootOk
      const failures = [...configFailures, ...compat, ...bootFailures]

      let fingerprint: string | null = null
      try {
        fingerprint = await io.computeFingerprint(profile.dir, version)
      } catch {
        fingerprint = null
      }

      let saveError: string | undefined
      if (fingerprint !== null) {
        const result: PrecheckResult = {
          at: io.now().toISOString(),
          ok,
          fingerprint,
          failures,
          durationMs: Math.max(0, Date.now() - startedAt),
        }
        try {
          // 通过：记 precheck + 本次完整名单做基线；不通过：只记 precheck，基线不动。
          const patch: Partial<LastRecord> = ok
            ? { precheck: result, baseline: [...smoke.failedEntries].sort(), fingerprint }
            : { precheck: result, fingerprint }
          await io.writeLast(io.logDir, patch)
        } catch (error) {
          saveError = '预检结果写盘失败：' + messageOf(error)
        }
      }
      // fingerprint 为 null：结果绑不到当前 profile，不写盘；status 会一直判过期。

      if (saveError === undefined) {
        write({ done: true })
      } else {
        console.error('[dsh-restart] ' + saveError)
        write({ done: true, error: saveError })
      }
      try {
        res.end()
      } catch {
        // 客户端先断了。
      }
    } catch (error) {
      console.error('[dsh-restart] 预检异常终止：' + messageOf(error))
      write({ done: true, error: '预检异常终止：' + messageOf(error) })
      try {
        res.end()
      } catch {
        // 同上。
      }
    }
  }

  const restart: RouteHandler = async (req, res) => {
    if (!guard(ctx, req, res, 'POST')) return
    const profile = profileOf(ctx)
    if (profile === undefined) {
      respondJson(res, 503, { ok: false, error: '取不到 profileContext，无法重启' })
      return
    }
    const port = currentPort(ctx)
    if (port === undefined) {
      respondJson(res, 503, { ok: false, error: 'webServer 还没监听端口，无法重启' })
      return
    }
    let refused = false
    try {
      refused = await io.isRefused(join(io.logDir, RESTART_LOCK_NAME))
    } catch {
      refused = false
    }
    if (refused) {
      respondJson(res, 409, { ok: false, error: '已有一个重启在进行中，等它结束再试' })
      return
    }

    const at = io.now().toISOString()
    let armed = false
    const arm = (): void => {
      if (armed) return
      armed = true
      // 响应已落 socket 才派生 helper；不在响应前拍脑袋延迟。
      io.scheduleRestart({
        port,
        profileDir: profile.dir,
        logDir: io.logDir,
        dshHome: profile.home,
        profileName: profile.name,
      })
    }

    // 'finish' = 响应真正写完；没有它（测试替身）才退回到 end 之后立刻派。
    const hasFinish = typeof res.once === 'function'
    if (hasFinish) res.once('finish', arm)
    res.statusCode = 202
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify({ ok: true, at, port }))
    if (!hasFinish) arm()
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

interface ProfileInfo {
  dir: string
  name: string
  home: string
}

function profileOf(ctx: RouteContext): ProfileInfo | undefined {
  let value: unknown
  try {
    value = ctx.get('profileContext')
  } catch {
    return undefined
  }
  if (!isRecord(value)) return undefined
  const dir = value.dir
  if (typeof dir !== 'string' || dir.trim() === '') return undefined
  const name = typeof value.name === 'string' && value.name !== '' ? value.name : basename(dir)
  const home = typeof value.home === 'string' && value.home !== '' ? value.home : dirname(dirname(dir))
  return { dir, name, home }
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
  try {
    const direct: unknown = Reflect.get(ctx, 'connection')
    if (isConnection(direct)) return direct
    const viaGet = ctx.get('connection')
    if (isConnection(viaGet)) return viaGet
  } catch {
    // 服务还没挂上：按拒绝处理。
  }
  return undefined
}

function isConnection(value: unknown): value is ConnectionLike {
  return isRecord(value) && typeof value.requestRejection === 'function'
}

/** undefined = 放行；数字 = 宿主给出的拒绝状态码；服务缺失时自己补一个 503。 */
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
 * 只对「本机回环 + GET status + 带 x-dsh-restart + 无 Origin」这一种请求放行；
 * 写操作（precheck/restart）永远不享受这个例外。
 */
function isLocalReadinessProbe(req: IncomingMessage, expected: 'GET' | 'POST'): boolean {
  if (expected !== 'GET') return false
  if ((req.method ?? '').toUpperCase() !== 'GET') return false
  const headers = headersRecord(req.headers)
  if (headerOf(headers, GUARD_HEADER) !== '1') return false
  if (headerOf(headers, 'origin') !== undefined) return false
  const address = req.socket?.remoteAddress
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function guard(ctx: RouteContext, req: IncomingMessage, res: ServerResponse, expected: 'GET' | 'POST'): boolean {
  let rejection = rejectionOf(ctx, req)
  if (rejection === 401 && isLocalReadinessProbe(req, expected)) rejection = undefined
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

async function stage(kind: Failure['kind'], run: () => Promise<Failure[]>): Promise<Failure[]> {
  try {
    return await run()
  } catch (error) {
    return [{ kind, message: '快检执行失败：' + messageOf(error) }]
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
