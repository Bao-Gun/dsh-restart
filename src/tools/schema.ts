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

/** Failure 的单行文本：缺的字段就不提，别把 undefined 拼进来。 */
export function failureLineOf(failure: unknown): string {
  if (typeof failure !== 'object' || failure === null) return '（无法识别的条目）'
  const record = failure as Record<string, unknown>
  const kind = typeof record.kind === 'string' ? record.kind : ''
  const message = typeof record.message === 'string' ? record.message : ''
  const details: string[] = []
  if (typeof record.plugin === 'string' && record.plugin !== '') details.push(record.plugin)
  if (typeof record.expected === 'string' && record.expected !== '') details.push('期望 ' + record.expected)
  if (typeof record.actual === 'string' && record.actual !== '') details.push('实际 ' + record.actual)
  const head = kind === '' ? message : '[' + kind + '] ' + message
  return details.length === 0 ? head : head + '（' + details.join('；') + '）'
}

/**
 * summary 打头，再把 failures / warnings 每条一行附上。
 * 工具值里没有 error 字段，失败原因就靠这几行交代清楚。
 */
export function renderWithIssues(_args: unknown, value: unknown): ToolTextBlock[] {
  const record = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  const blocks: ToolTextBlock[] = [{ type: 'text', text: summaryTextOf(value) }]
  for (const failure of listOf(record.failures)) blocks.push({ type: 'text', text: '失败：' + failureLineOf(failure) })
  for (const warning of listOf(record.warnings)) blocks.push({ type: 'text', text: '提示：' + failureLineOf(warning) })
  return blocks
}

function listOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}
