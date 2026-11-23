/**
 * `dsh_restart` 工具：先预检（force=true 除外），通过后把重启排进定时器再结束本轮。
 *
 * 守卫、预检与延迟派生分别复用 server/issue.ts / server/precheck.ts；
 * 这里只做参数映射、互斥配平与结果映射，不另写一份判定。
 */
import {
  endRestart,
  issueRestartLater,
  restartGuards,
  tryBeginRestart,
  RESTART_BUSY_ERROR,
} from '../server/issue'
import { isStale } from '../server/last'
import { acquirePrecheck, releasePrecheck, runPrecheckRun } from '../server/precheck'
import type { PrecheckOutcome, PrecheckTarget } from '../server/precheck'
import { profileOf } from '../server/profile'
import type { Failure } from '../shared/types'
import type { ToolContextLike, ToolDefinitionLike, ToolExecLike, ToolIo } from './index'
import { FAILURE_SCHEMA, renderWithIssues } from './schema'

/** force 是唯一参数：预检判红时仍需显式传 true 才放行。 */
const PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {
    force: {
      type: 'boolean',
      description: '跳过预检直接重启；正常情况不要传，先让预检拦一遍再决定。',
    },
  },
  additionalProperties: false,
}

/**
 * reason 的取值（string，不是枚举）：
 * - 'restarting'：已排进定时器，本轮结束后重启
 * - 'busy'：已有重启在进行（进程互斥或 restart.lock 被占）
 * - 'no-profile'：取不到 profileContext
 * - 'no-port'：webServer 还没监听端口
 * - 'precheck-failed'：预检判红且没有 force
 * - 'precheck-busy'：另一轮预检正拿着工具侧的锁
 * - 'cancelled'：信号在预检前/预检中被取消
 * - 'error'：守卫、指纹或预检核心意外抛错
 */
type RestartReason =
  | 'restarting'
  | 'busy'
  | 'no-profile'
  | 'no-port'
  | 'precheck-failed'
  | 'precheck-busy'
  | 'cancelled'
  | 'error'

/** 与 Task 5 的 RestartToolValue 一一对应；8 个字段全 required。 */
interface RestartToolValue {
  ok: boolean
  restarted: boolean
  reason: RestartReason
  port: number
  profileName: string
  failures: Failure[]
  warnings: Failure[]
  summary: string
}

const OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    restarted: { type: 'boolean' },
    reason: { type: 'string' },
    port: { type: 'number' },
    profileName: { type: 'string' },
    failures: { type: 'array', items: FAILURE_SCHEMA },
    warnings: { type: 'array', items: FAILURE_SCHEMA },
    summary: { type: 'string' },
  },
  required: ['ok', 'restarted', 'reason', 'port', 'profileName', 'failures', 'warnings', 'summary'],
  additionalProperties: false,
}

/** 留给工具结果落盘的时间；helper 起步就可能掐掉本进程。 */
const TOOL_RESTART_DELAY_MS = 2500

/** 每个早退分支都要填满 8 个字段：缺省用空数组 / 空串 / 0，绝不留 undefined。 */
function valueOf(
  patch: Partial<RestartToolValue> & Pick<RestartToolValue, 'ok' | 'restarted' | 'reason' | 'summary'>,
): RestartToolValue {
  return {
    ok: patch.ok,
    restarted: patch.restarted,
    reason: patch.reason,
    port: patch.port ?? 0,
    profileName: patch.profileName ?? '',
    failures: patch.failures ?? [],
    warnings: patch.warnings ?? [],
    summary: patch.summary,
  }
}

/** webServer 端口：拿不到、不是正整数都按「未知」处理，交给守卫报 no-port。 */
function portOf(ctx: ToolContextLike): number | undefined {
  try {
    const webServer = ctx.get('webServer') as { port?: unknown } | undefined
    const port = webServer?.port
    return typeof port === 'number' && Number.isInteger(port) && port > 0 ? port : undefined
  } catch {
    return undefined
  }
}

/**
 * 上次预检还新鲜且通过吗？指纹取不到（null）视为不新鲜，必须重跑。
 * 读盘用注入的 io.readLast，与预检核心看的是同一个 last.json。
 */
async function freshPassed(io: ToolIo, target: PrecheckTarget): Promise<boolean> {
  const record = await io.readLast(io.logDir)
  if (record?.precheck?.ok !== true) return false
  const fingerprint = await io.computeFingerprint(target.dir, io.runtimeVersion())
  return !isStale(record, fingerprint)
}

/** 判红时的一句话：第一条 failure 打头，写盘错误有就补上。 */
function redSummary(outcome: PrecheckOutcome): string {
  const first = outcome.failures[0]
  const head = first === undefined ? '检查没通过' : '检查没通过：' + first.message
  return outcome.error === undefined ? head : head + '（' + outcome.error + '）'
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** concludeTurn 在测试替身里未必存在；宿主里抛错也不该把已排好的重启变成失败。 */
function conclude(exec: ToolExecLike): void {
  if (typeof exec.concludeTurn !== 'function') return
  try {
    exec.concludeTurn()
  } catch {
    // 已经 issueRestartLater，本轮标记失败没有意义。
  }
}

export function createRestartTool(ctx: ToolContextLike, io: ToolIo): ToolDefinitionLike {
  return {
    name: 'dsh_restart',
    description:
      '重启本机 dsh web：先跑预检（除非 force=true），通过后延迟派生 helper 并中断当前会话；重启完成后硬刷页面。',
    parameters: PARAMETERS,
    output: { schema: OUTPUT_SCHEMA, render: renderWithIssues },
    async execute(args: unknown, exec: ToolExecLike): Promise<unknown> {
      const target = profileOf(ctx)
      const port = portOf(ctx)
      const base = { port: port ?? 0, profileName: target?.name ?? '' }

      try {
        if (target === undefined) {
          return valueOf({
            ...base,
            ok: false,
            restarted: false,
            reason: 'no-profile',
            summary: '重启不了：取不到 profileContext',
          })
        }
        if (exec.signal?.aborted === true) {
          return valueOf({ ...base, ok: false, restarted: false, reason: 'cancelled', summary: '预检已取消，没有重启' })
        }
        // 进程内互斥：挡住同一进程里同时点两次；跨进程仍以 restart.lock 为准。
        if (!tryBeginRestart()) {
          return valueOf({
            ...base,
            ok: false,
            restarted: false,
            reason: 'busy',
            summary: '无法重启：' + RESTART_BUSY_ERROR,
          })
        }

        let released = false
        const release = (): void => {
          if (released) return
          released = true
          endRestart()
        }

        try {
          const guard = await restartGuards(io, target, port)
          if (!guard.ok) {
            return valueOf({
              ...base,
              ok: false,
              restarted: false,
              reason: guard.status === 409 ? 'busy' : port === undefined ? 'no-port' : 'error',
              summary: '无法重启：' + guard.error,
            })
          }
          if (port === undefined) {
            // 守卫已拦过端口缺失；这里只为让类型收窄，正常到不了。
            return valueOf({
              ...base,
              ok: false,
              restarted: false,
              reason: 'no-port',
              summary: '无法重启：webServer 还没监听端口，无法重启',
            })
          }

          const force = typeof args === 'object' && args !== null && (args as { force?: unknown }).force === true
          if (!force && !(await freshPassed(io, target))) {
            if (!acquirePrecheck()) {
              return valueOf({
                ...base,
                ok: false,
                restarted: false,
                reason: 'precheck-busy',
                summary: '另一个预检正在进行，等它结束再试',
              })
            }
            let outcome: PrecheckOutcome
            try {
              outcome = await runPrecheckRun(io, target, { isCancelled: () => exec.signal?.aborted === true })
            } finally {
              releasePrecheck()
            }
            if (outcome.cancelled) {
              return valueOf({
                ...base,
                ok: false,
                restarted: false,
                reason: 'cancelled',
                summary: '预检已取消，没有重启',
              })
            }
            if (!outcome.ok) {
              return valueOf({
                ...base,
                ok: false,
                restarted: false,
                reason: 'precheck-failed',
                failures: outcome.failures,
                warnings: outcome.warnings,
                summary: redSummary(outcome),
              })
            }
          }

          // 顺序不能反：先把派生排进定时器，再标记本轮终点；否则结果还没回到宿主就被换掉。
          release()
          issueRestartLater(io, target, port, TOOL_RESTART_DELAY_MS)
          conclude(exec)
          return valueOf({
            ...base,
            ok: true,
            restarted: true,
            reason: 'restarting',
            summary: '重启已排入队列：约 2.5 秒后重启 dsh web（端口 ' + port + '，profile ' + target.name + '）',
          })
        } finally {
          release()
        }
      } catch (err) {
        return valueOf({
          ...base,
          ok: false,
          restarted: false,
          reason: 'error',
          summary: '重启前检查出错：' + messageOf(err),
        })
      }
    },
  }
}
