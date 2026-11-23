/**
 * 重启发起核心：守卫、arm、延迟派生与进程级互斥。
 *
 * 路由（HTTP）与 agent 工具共用这一份实现。这里不感知请求/响应对象：
 * `x-dsh-restart` 头、方法、`requestRejection`、401 例外这些请求门判定
 * 留在 `src/index.ts`，锁文件是否被占通过 `RestartIssueIo.isRefused` 注入。
 *
 * 运行期只依赖 node 内置模块与本包的 server 模块，不引任何第三方包或 @deepseek-ai/*。
 */
import { join } from 'node:path'

import type { PrecheckTarget } from './precheck'
import { RESTART_LOCK_NAME } from './restart'
import type { ScheduleRestartOptions } from './restart'

/** 重启守卫与派发用到的全部 IO；测试注入假实现，生产直接复用 RouteIo。 */
export interface RestartIssueIo {
  logDir: string
  isRefused(lockPath: string): Promise<boolean>
  scheduleRestart(options: ScheduleRestartOptions): void
}

export type RestartGuard =
  | { ok: true }
  | { ok: false; status: 409 | 503; error: string }

/** 锁被占与进程内互斥共用同一句文案：用户看到的都是「等它结束再试」。 */
export const RESTART_BUSY_ERROR = '已有一个重启在进行中，等它结束再试'

/**
 * 进程级重启互斥：挡住同一进程里同时点两次；跨进程仍以 helper 的
 * restart.lock 为准（restartGuards 查的就是那个锁）。
 */
let restartStarting = false

/** 拿重启互斥；拿不到说明已有一次判定/派生在路上。 */
export function tryBeginRestart(): boolean {
  if (restartStarting) return false
  restartStarting = true
  return true
}

/** 释放重启互斥（幂等）。 */
export function endRestart(): void {
  restartStarting = false
}

/**
 * 重启前的三项守卫，顺序与旧 handler 一致：profile → port → lock。
 *
 * 任何一项不满足都返回 `ok: false` 与现成的 HTTP 状态码/文案，由调用方
 * 决定怎么呈现（路由回 JSON，工具映射成 reason）。查锁出错按「没有锁」放行，
 * 与旧 handler 一致：真正的互斥裁决在 helper 取锁那一刻。
 */
export async function restartGuards(
  io: RestartIssueIo,
  target: PrecheckTarget | undefined,
  port: number | undefined,
): Promise<RestartGuard> {
  if (target === undefined) {
    return { ok: false, status: 503, error: '取不到 profileContext，无法重启' }
  }
  if (port === undefined) {
    return { ok: false, status: 503, error: 'webServer 还没监听端口，无法重启' }
  }
  let refused = false
  try {
    refused = await io.isRefused(join(io.logDir, RESTART_LOCK_NAME))
  } catch {
    refused = false
  }
  if (refused) return { ok: false, status: 409, error: RESTART_BUSY_ERROR }
  return { ok: true }
}

/**
 * 立刻派生 helper（路由在响应 finish 后调用）。
 *
 * 显式带上 dshHome / profileName：helper 不再从 profileDir 反推，避免猜错 profile。
 */
export function armRestart(io: RestartIssueIo, target: PrecheckTarget, port: number): void {
  io.scheduleRestart({
    port,
    profileDir: target.dir,
    logDir: io.logDir,
    dshHome: target.home,
    profileName: target.name,
  })
}

/**
 * 延迟派生（工具用）：返回取消函数；定时器 unref，不挡进程退出。
 *
 * 延迟是给本轮响应/工具结果留出落盘时间——helper 起步就可能掐掉本进程。
 * 幂等：fire 与 cancel 谁先到都只生效一次。互斥不在这里管，调用方自己
 * `tryBeginRestart` / `endRestart`。
 */
export function issueRestartLater(
  io: RestartIssueIo,
  target: PrecheckTarget,
  port: number,
  delayMs: number,
): { cancel(): void } {
  let fired = false
  const fire = (): void => {
    if (fired) return
    fired = true
    armRestart(io, target, port)
  }

  const delay = Number.isFinite(delayMs) && delayMs > 0 ? delayMs : 0
  const timer = setTimeout(fire, delay)
  // Node 的 Timeout 才有 unref；假定时器之类的替身没有就跳过。
  if (typeof timer.unref === 'function') timer.unref()

  return {
    cancel(): void {
      if (fired) return
      fired = true
      clearTimeout(timer)
    },
  }
}
