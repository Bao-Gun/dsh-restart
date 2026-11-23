/**
 * 两个工具共用的输出 schema 片段。
 *
 * 输出 schema 会被宿主按 JSON Schema 强校验（additionalProperties: false），
 * 所以执行体返回值里不得出现 undefined / 函数 / 类实例；这里只声明 JSON 值。
 */
import type { ToolTextBlock } from './index'

/** Failure（src/shared/types.ts）的 JSON Schema：plugin / expected / actual 可省。 */
export const FAILURE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    plugin: { type: 'string' },
    kind: { type: 'string', enum: ['config', 'compat', 'boot'] },
    message: { type: 'string' },
    expected: { type: 'string' },
    actual: { type: 'string' },
  },
  required: ['kind', 'message'],
  additionalProperties: false,
}

/** 工具值的模型可见文本：统一取 summary，缺了就明说，不猜。 */
export function summaryTextOf(value: unknown): string {
  if (typeof value === 'object' && value !== null) {
    const summary = (value as { summary?: unknown }).summary
    if (typeof summary === 'string') return summary
  }
  return '（没有摘要）'
}

/** 只回一行文本的工具 render。 */
export function renderSummary(_args: unknown, value: unknown): ToolTextBlock[] {
  return [{ type: 'text', text: summaryTextOf(value) }]
}
