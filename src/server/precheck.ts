/**
 * 预检核心：配置合成 → 兼容性 → 克隆试跑 → 基线差分 → 落盘。
 *
 * 路由（HTTP + NDJSON）和 agent 工具共用这一份实现。这里不碰请求/响应：
 * 每跑完一段就调用一次 `onStage`，由调用方决定是写 NDJSON 行还是攒结果。
 *
 * 运行期只依赖 node 内置模块与本包的 server 模块，不引任何第三方包或 @deepseek-ai/*。
 */
import type { Failure, LastRecord, PrecheckResult } from '../shared/types'
import type { InstalledPlugin } from './compat'
import { compatFailures, readInstalled } from './compat'
import { computeFingerprint, readLast, writeLast } from './last'
import { diffFailedEntries, runDumpConfig, runSmoke } from './smoke'
import type { SmokeResult } from './smoke'

/** 预检用到的全部 IO / 时钟。测试注入假实现，生产走 defaultIo()。 */
export interface PrecheckIo {
  now(): Date
  readLast(dir: string): Promise<LastRecord>
  writeLast(dir: string, patch: Partial<LastRecord>): Promise<void>
  computeFingerprint(profileDir: string, dshVersion: string | null): Promise<string | null>
  runtimeVersion(): string | null
  runDumpConfig(profileDir: string): Promise<Failure[]>
  readInstalled(profileDir: string, onWarning?: (failure: Failure) => void): Promise<InstalledPlugin[]>
  compatFailures(plugins: InstalledPlugin[], runtimeVersion: string): Failure[]
  runSmoke(options: { profileDir: string; tmpRoot: string }): Promise<SmokeResult>
  tmpRoot: string
  logDir: string
}

/** 预检的宿主上下文：profile 目录 + 名字 + dsh home。 */
export interface PrecheckTarget {
  dir: string
  name: string
  home: string
}

export type PrecheckStage =
  | { stage: 'config'; ok: boolean; failures: Failure[] }
  | { stage: 'compat'; ok: true; failures: []; warnings: Failure[] }
  | {
      stage: 'boot'
      ok: boolean
      failures: Failure[]
      warnings: Failure[]
      entries: string[]
      added: string[]
      health: boolean
    }

export interface PrecheckOutcome {
  ok: boolean
  saved: boolean
  cancelled: boolean
  fingerprint: string | null
  failures: Failure[]
  warnings: Failure[]
  entries: string[]
  health: boolean
  durationMs: number
  error?: string
}

/** 进程级互斥：同一进程只允许一轮预检（路由与工具共用这一把锁）。 */
let running = false

export function acquirePrecheck(): boolean {
  if (running) return false
  running = true
  return true
}

export function releasePrecheck(): void {
  running = false
}

interface RunOptions {
  onStage?: (stage: PrecheckStage) => void
  isCancelled?: () => boolean
}

/**
 * 跑完整轮预检。
 *
 * 取消语义与路由时代一致：每个耗时步骤之后检查一次；一旦取消就返回
 * `cancelled: true`，不写盘、不判通过，并带上已经跑完的冒烟字段，供调用方
 * 补一条「这轮没结论」的收尾行。
 */
export async function runPrecheckRun(
  io: PrecheckIo,
  target: PrecheckTarget,
  options: RunOptions = {},
): Promise<PrecheckOutcome> {
  const startedAt = Date.now()
  const elapsed = (): number => Math.max(0, Date.now() - startedAt)
  const cancelled = (): boolean => options.isCancelled?.() ?? false
  const cancelledOutcome = (smoke?: SmokeResult): PrecheckOutcome => ({
    ok: false,
    saved: false,
    cancelled: true,
    fingerprint: null,
    failures: smoke?.failures ?? [],
    warnings: [],
    entries: smoke?.failedEntries ?? [],
    health: smoke?.health ?? false,
    durationMs: elapsed(),
  })

  try {
    // 快检 A：配置合成本身会不会挂。
    const configFailures = await stage('config', () => io.runDumpConfig(target.dir))
    options.onStage?.({ stage: 'config', ok: configFailures.length === 0, failures: configFailures })

    // 快检 B：装着的插件跟当前 dsh 版本兼不兼容。
    //
    // 这一段的结论**不拦重启**：宿主遇到版本不符、清单读不动的插件只会跳过它，
    // dsh web 照样起得来（实机上 dsh-mcp-connector 缺包也一直是这个状态）。
    // 拦下来只会让预检永远过不去，让人没法重启；所以全部降级成「提示」，
    // 真起不来的情况交给下面的试启动去抓。
    const version = io.runtimeVersion()
    const pluginWarnings: Failure[] = []
    try {
      const plugins = await io.readInstalled(target.dir, (failure) => pluginWarnings.push(failure))
      pluginWarnings.push(...io.compatFailures(plugins, version ?? ''))
    } catch (error) {
      pluginWarnings.push({ kind: 'compat', message: '兼容性检查没跑完：' + messageOf(error) })
    }
    options.onStage?.({ stage: 'compat', ok: true, failures: [], warnings: pluginWarnings })

    if (cancelled()) return cancelledOutcome()

    // 快检 C：克隆 profile 真起一个实例，收未激活名单并跟基线差分。
    let smoke: SmokeResult
    try {
      smoke = await io.runSmoke({ profileDir: target.dir, tmpRoot: io.tmpRoot })
    } catch (error) {
      smoke = {
        ok: false,
        health: false,
        failures: [{ kind: 'boot', message: '冒烟执行失败：' + messageOf(error) }],
        failedEntries: [],
        durationMs: 0,
      }
    }
    // 冒烟已经跑完（没法中途杀），但这轮结论不写盘、也不当成通过。
    if (cancelled()) return cancelledOutcome(smoke)

    const previous = await safeReadLast(io)
    const { added } = diffFailedEntries(smoke.failedEntries, previous.baseline ?? [])
    const newEntrySet = new Set(added)
    // 没激活的插件同样是「提示」：试跑已经证明服务能起来，起不来会在 smoke.failures 里。
    // 与上次通过的基线不同的那几条再额外标一句，方便看出「这次新弄坏的」是谁。
    const bootWarnings: Failure[] = smoke.failedEntries.map((entry) => ({
      plugin: entry,
      kind: 'boot',
      message: newEntrySet.has(entry)
        ? `${entry} 没有激活（不在上次通过的基线里）`
        : `${entry} 没有激活（上次通过时也是这样）`,
    }))
    const bootFailures = smoke.failures
    // runSmoke.ok 已包含 health 200 与「临时目录 / 进程组清理干净」。
    const bootOk = smoke.ok && smoke.health && bootFailures.length === 0
    options.onStage?.({
      stage: 'boot',
      ok: bootOk,
      failures: bootFailures,
      warnings: bootWarnings,
      entries: smoke.failedEntries,
      added,
      health: smoke.health,
    })

    const ok = configFailures.length === 0 && bootOk
    const failures = [...configFailures, ...bootFailures]
    const warnings = [...pluginWarnings, ...bootWarnings]

    let fingerprint: string | null = null
    try {
      fingerprint = await io.computeFingerprint(target.dir, version)
    } catch {
      fingerprint = null
    }

    // 取消点保持原位置：boot 行已经发出去之后取消，调用方仍会补 cancelled 收尾。
    if (cancelled()) return cancelledOutcome(smoke)

    if (fingerprint !== null) {
      const result: PrecheckResult = {
        at: io.now().toISOString(),
        ok,
        fingerprint,
        failures,
        warnings,
        durationMs: elapsed(),
      }
      try {
        // 通过：记 precheck + 本次完整名单做基线；不通过：也同步指纹（Task 2 的不变量），
        // 但基线不动。这样 status 能分清「通过后 profile 又变了」和「上次就没过」。
        const patch: Partial<LastRecord> = ok
          ? { precheck: result, baseline: [...smoke.failedEntries].sort(), fingerprint }
          : { precheck: result, fingerprint }
        await io.writeLast(io.logDir, patch)
      } catch (error) {
        const saveError = '预检结果写盘失败：' + messageOf(error)
        console.error('[dsh-restart] ' + saveError)
        return {
          ok,
          saved: false,
          cancelled: false,
          fingerprint,
          failures,
          warnings,
          entries: smoke.failedEntries,
          health: smoke.health,
          durationMs: elapsed(),
          error: saveError,
        }
      }
    }
    // fingerprint 为 null：结果绑不到当前 profile，不写盘；status 会一直判过期。
    // 因此 saved 必须是 false，别让客户端把「阶段都绿了」当成可用的通过结论。

    return {
      ok,
      saved: fingerprint !== null,
      cancelled: false,
      fingerprint,
      failures,
      warnings,
      entries: smoke.failedEntries,
      health: smoke.health,
      durationMs: elapsed(),
    }
  } catch (error) {
    const message = '预检异常终止：' + messageOf(error)
    console.error('[dsh-restart] ' + message)
    return {
      ok: false,
      saved: false,
      cancelled: false,
      fingerprint: null,
      failures: [],
      warnings: [],
      entries: [],
      health: false,
      durationMs: elapsed(),
      error: message,
    }
  }
}

async function safeReadLast(io: PrecheckIo): Promise<LastRecord> {
  try {
    return await io.readLast(io.logDir)
  } catch {
    return {}
  }
}

async function stage(kind: Failure['kind'], run: () => Promise<Failure[]>): Promise<Failure[]> {
  try {
    return await run()
  } catch (error) {
    return [{ kind, message: '快检执行失败：' + messageOf(error) }]
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
