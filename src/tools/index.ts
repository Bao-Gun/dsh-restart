/**
 * agent 工具注册骨架：把「预检」「重启」两个工具挂到宿主的工具注册表。
 *
 * 约束（与计划一致）：
 * - 运行期零第三方依赖、零 @deepseek-ai/* import；工具定义写成普通对象，宿主只按结构消费。
 * - 注册表必须走 ctx.get('tools')：未 inject 时访问 ctx.tools 会被 cordis 抛
 *   'cannot get property "tools" without inject'。
 * - 注册包在 ctx.effect 里，返回的 disposer 在插件卸载时反注册。
 *
 * 判定逻辑不在这里：两个工具的执行体（Task 4 / Task 5）只调用
 * server/precheck.ts 与 server/issue.ts 的导出。
 */
import type { RestartIssueIo } from '../server/issue'
import type { PrecheckIo } from '../server/precheck'
import { createPrecheckTool } from './precheck'
import { createRestartTool } from './restart'

/** 执行上下文里本插件用到的部分；宿主传入的 exec 结构上包含它们。 */
export interface ToolExecLike {
  readonly signal?: AbortSignal
  concludeTurn?(): void
}

export type ToolTextBlock = { type: 'text'; text: string }

/** 工具定义的普通对象形状；字段与宿主 ToolDefinition 对齐，但不 import 它。 */
export interface ToolDefinitionLike {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render(args: unknown, value: unknown): ToolTextBlock[]
  }
  execute(args: unknown, exec: ToolExecLike): Promise<unknown>
}

export interface ToolsRegistryLike {
  register(definition: ToolDefinitionLike): () => void
}

/** 预检/重启核心的 IO，加上重启判定与派生；形状直接复用 issue.ts 的 RestartIssueIo。 */
export type ToolIo = PrecheckIo & RestartIssueIo

export interface ToolContextLike {
  get(service: string): unknown
  effect(callback: () => void | (() => void), label?: string): void
}

/** 取工具注册表：只认 ctx.get('tools')，形状不对一律当没有。 */
export function toolsOf(ctx: { get(service: string): unknown }): ToolsRegistryLike | undefined {
  let value: unknown
  try {
    value = ctx.get('tools')
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const register = (value as { register?: unknown }).register
  if (typeof register !== 'function') return undefined
  // bind 一下：注册表实现可能是类实例，register 依赖 this。
  return { register: (register as ToolsRegistryLike['register']).bind(value) }
}

/** 本插件对外暴露的全部工具定义；测试按名字/顺序断言这份清单。 */
export function toolDefinitions(ctx: ToolContextLike, io: ToolIo): ToolDefinitionLike[] {
  return [createPrecheckTool(ctx, io), createRestartTool(ctx, io)]
}

/**
 * 注册两个工具；返回实际注册的个数。
 * 宿主没有 tools 服务时返回 0 并只打一条日志（不是所有 dsh 场景都装了工具服务）。
 */
export function registerTools(ctx: ToolContextLike, io: ToolIo): number {
  const tools = toolsOf(ctx)
  if (tools === undefined) {
    console.warn('[dsh-restart] 宿主没有 tools 服务，两个 agent 工具不注册')
    return 0
  }

  let count = 0
  for (const definition of toolDefinitions(ctx, io)) {
    ctx.effect(() => {
      const dispose = tools.register(definition)
      return () => dispose()
    }, 'dsh-restart: ' + definition.name)
    count += 1
  }
  return count
}
