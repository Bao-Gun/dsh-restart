/**
 * `dsh_restart` 工具：先只声明形状，执行体由 Task 5 补。
 *
 * 守卫、预检复用与延迟派生都在 server/issue.ts / server/precheck.ts 里；
 * Task 5 只做参数映射与结果映射，不另写一份判定。
 */
import type { ToolContextLike, ToolDefinitionLike, ToolIo } from './index'
import { FAILURE_SCHEMA, renderSummary } from './schema'

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

/** 与 Task 5 的 RestartToolValue 一一对应；执行体必须补齐每个 required 字段。 */
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

export function createRestartTool(_ctx: ToolContextLike, _io: ToolIo): ToolDefinitionLike {
  return {
    name: 'dsh_restart',
    description:
      '重启本机 dsh web：先跑预检（除非 force=true），通过后延迟派生 helper 并中断当前会话；重启完成后硬刷页面。',
    parameters: PARAMETERS,
    output: { schema: OUTPUT_SCHEMA, render: renderSummary },
    async execute(): Promise<unknown> {
      throw new Error('dsh_restart 的执行体还没实现（Task 5）')
    },
  }
}
