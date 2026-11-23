/**
 * 当前 profile 的识别：只认 ctx.get('profileContext')。
 *
 * 从 src/index.ts 搬出来，因为路由和 agent 工具都要用它；取不到就返回 undefined，
 * 由调用方各自 fail-closed（路由回 503，工具返回 ok:false 的结论）。
 *
 * 运行期只依赖 node 内置模块。
 */
import { basename, dirname } from 'node:path'

export interface ProfileInfo {
  dir: string
  name: string
  home: string
}

/**
 * profileContext 的三种缺省处理：
 * - dir 必须有值，否则整份判无效；
 * - name 缺省取目录名；
 * - home 缺省取 dir 的上上级（<home>/profiles/<name>）。
 *
 * cordis 未 inject 时属性访问会抛，所以这里只用 ctx.get，并把抛错当成「没有」。
 */
export function profileOf(ctx: { get(service: string): unknown }): ProfileInfo | undefined {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
