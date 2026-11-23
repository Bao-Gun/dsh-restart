/**
 * `dsh_restart_precheck` 工具：先只声明形状，执行体由 Task 4 补。
 *
 * 判定逻辑不在这里复述：Task 4 直接调用 server/precheck.ts 的
 * runPrecheckRun / acquirePrecheck / releasePrecheck。
 */
import type { ToolContextLike, ToolDefinitionLike, ToolIo } from './index'
import { FAILURE_SCHEMA, renderSummary } from './schema'

const PARAMETERS: Record<string, unknown> = { type: 'object', properties: {}, additionalProperties: false }

/** 与 Task 4 的 PrecheckToolValue 一一对应；执行体必须补齐每个 required 字段。 */
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

export function createPrecheckTool(_ctx: ToolContextLike, _io: ToolIo): ToolDefinitionLike {
  return {
    name: 'dsh_restart_precheck',
    description:
      '跑一轮 dsh web 启动预检（配置合成、插件兼容、克隆 profile 试启动），只检查、不重启；返回是否通过、失败/提示清单与 profile 指纹。',
    parameters: PARAMETERS,
    output: { schema: OUTPUT_SCHEMA, render: renderSummary },
    async execute(): Promise<unknown> {
      throw new Error('dsh_restart_precheck 的执行体还没实现（Task 4）')
    },
  }
}
