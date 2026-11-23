/**
 * `dsh_restart_precheck` 工具：跑一轮完整预检，把核心的 outcome 映射成工具值。
 *
 * 这里不判定、也不落盘：判定与写 last.json 都在 server/precheck.ts 里，
 * 工具只做「取 profile → 抢进程锁 → 调核心 → 映射结果」。再写一份结果就违反
 * 「同一轮预检只有一份落盘记录」的约束。
 *
 * 取消交给核心的 isCancelled：核心负责清掉试跑进程且不落盘；工具只把
 * `cancelled: true` 带回去，不自己硬杀。
 */
import { acquirePrecheck, releasePrecheck, runPrecheckRun } from '../server/precheck'
import type { PrecheckOutcome } from '../server/precheck'
import { profileOf } from '../server/profile'
import type { Failure } from '../shared/types'
import type { ToolContextLike, ToolDefinitionLike, ToolExecLike, ToolIo } from './index'
import { FAILURE_SCHEMA, redSummaryOf, renderWithIssues } from './schema'

const PARAMETERS: Record<string, unknown> = { type: 'object', properties: {}, additionalProperties: false }

/** 与 PrecheckToolValue 一一对应；执行体必须补齐每个 required 字段。 */
const OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    busy: { type: 'boolean' },
    cancelled: { type: 'boolean' },
    saved: { type: 'boolean' },
    durationMs: { type: 'number' },
    health: { type: 'boolean' },
    failures: { type: 'array', items: FAILURE_SCHEMA },
    warnings: { type: 'array', items: FAILURE_SCHEMA },
    entries: { type: 'array', items: { type: 'string' } },
    fingerprint: { type: 'string' },
    summary: { type: 'string' },
  },
  required: [
    'ok',
    'busy',
    'cancelled',
    'saved',
    'durationMs',
    'health',
    'failures',
    'warnings',
    'entries',
    'fingerprint',
    'summary',
  ],
  additionalProperties: false,
}

/**
 * 工具值契约（11 个字段就是契约，不要再加 error 之类的新字段）。
 * 每个字段都必须有值：宿主按 additionalProperties: false 强校验，undefined 过不去。
 */
export interface PrecheckToolValue {
  ok: boolean
  busy: boolean
  cancelled: boolean
  saved: boolean
  durationMs: number
  health: boolean
  failures: Failure[]
  warnings: Failure[]
  entries: string[]
  /** 取不到时为空字符串 */
  fingerprint: string
  summary: string
}

const NO_PROFILE_SUMMARY = '取不到 profileContext，无法预检'
const BUSY_SUMMARY = '已有一轮预检在进行，等它结束再试'
const CANCELLED_SUMMARY = '这轮预检被取消，不作数'

export function createPrecheckTool(ctx: ToolContextLike, io: ToolIo): ToolDefinitionLike {
  return {
    name: 'dsh_restart_precheck',
    description:
      '跑一轮 dsh web 启动预检（配置合成、插件兼容、克隆 profile 试启动），只检查、不重启；返回是否通过、失败/提示清单与 profile 指纹。',
    parameters: PARAMETERS,
    output: { schema: OUTPUT_SCHEMA, render: renderWithIssues },
    async execute(_args: unknown, exec: ToolExecLike): Promise<unknown> {
      const target = profileOf(ctx)
      if (target === undefined) return valueOf({ summary: NO_PROFILE_SUMMARY })

      // 锁是进程级的：拿不到就说明路由或另一个工具正在跑。不排队、不跑任何一步，
      // 更不能 release——那把锁是别人的。
      if (!acquirePrecheck()) return valueOf({ busy: true, summary: BUSY_SUMMARY })

      let outcome: PrecheckOutcome
      try {
        // 取消交给核心：它会清掉试跑进程、不写盘；这里只负责把结论带回去。
        outcome = await runPrecheckRun(io, target, {
          isCancelled: () => exec.signal?.aborted === true,
        })
      } catch (error) {
        // 核心按约定不抛错；这里兜底，免得宿主拿到一条没有结果的工具调用。
        const message = error instanceof Error ? error.message : String(error)
        return valueOf({ summary: '预检异常终止：' + message })
      } finally {
        // 正常、取消、抛错都必须放锁，否则后续预检永远 busy。
        releasePrecheck()
      }

      return valueOfOutcome(outcome)
    },
  }
}

/** 中性值：未跑预检的分支（缺 profile / busy）只覆盖需要说明的字段。 */
function valueOf(overrides: Partial<PrecheckToolValue> = {}): PrecheckToolValue {
  return {
    ok: false,
    busy: false,
    cancelled: false,
    saved: false,
    durationMs: 0,
    health: false,
    failures: [],
    warnings: [],
    entries: [],
    fingerprint: '',
    summary: '',
    ...overrides,
  }
}

/** PrecheckOutcome → 工具值；每个字段都落到具体值，不把 null / undefined 带出去。 */
function valueOfOutcome(outcome: PrecheckOutcome): PrecheckToolValue {
  return {
    ok: outcome.ok,
    busy: false,
    cancelled: outcome.cancelled,
    saved: outcome.saved,
    durationMs: outcome.durationMs,
    health: outcome.health,
    failures: copyFailures(outcome.failures),
    warnings: copyFailures(outcome.warnings),
    entries: [...outcome.entries],
    fingerprint: outcome.fingerprint ?? '',
    summary: summaryOf(outcome),
  }
}

/**
 * 一句话结论：
 * - 取消优先于判红（取消的 outcome 里 ok 也是 false，别报成「没通过」）；
 * - 判红报第一条 failure 的 message；没有 failure 时用 error 兜底；
 * - 通过但没落盘（写盘失败 / 拿不到指纹）必须说清楚，别让调用方以为结论可用。
 */
function summaryOf(outcome: PrecheckOutcome): string {
  if (outcome.cancelled) return CANCELLED_SUMMARY

  const error = typeof outcome.error === 'string' && outcome.error !== '' ? outcome.error : undefined
  if (!outcome.ok) return redSummaryOf(outcome)
  if (outcome.saved) return `检查通过：配置能合成，试跑实例起来了（${outcome.warnings.length} 条提示）`
  return error ?? '检查通过，但拿不到 profile 指纹，结果没落盘'
}

/** Failure 只留 JSON 值：可省字段缺了就不复制，保证工具值里没有 undefined。 */
function copyFailures(failures: Failure[]): Failure[] {
  return failures.map((failure) => {
    const copy: Failure = { kind: failure.kind, message: failure.message }
    if (typeof failure.plugin === 'string') copy.plugin = failure.plugin
    if (typeof failure.expected === 'string') copy.expected = failure.expected
    if (typeof failure.actual === 'string') copy.actual = failure.actual
    return copy
  })
}
