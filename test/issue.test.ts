import { afterEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'

import {
  RESTART_BUSY_ERROR,
  armRestart,
  endRestart,
  issueRestartLater,
  restartGuards,
  tryBeginRestart,
} from '../src/server/issue'
import type { RestartIssueIo } from '../src/server/issue'
import type { PrecheckTarget } from '../src/server/precheck'
import { RESTART_LOCK_NAME } from '../src/server/restart'
import type { ScheduleRestartOptions } from '../src/server/restart'

const TARGET: PrecheckTarget = { dir: '/home/u/.dsh/profiles/web', name: 'web', home: '/home/u/.dsh' }
const LOG_DIR = '/tmp/dsh-restart-test/log'

/** 假 io：只实现 RestartIssueIo；scheduled / refusedPaths 让用例能断言副作用。 */
function fakeIo(overrides: Partial<RestartIssueIo> = {}): {
  io: RestartIssueIo
  scheduled: ScheduleRestartOptions[]
  refusedPaths: string[]
} {
  const scheduled: ScheduleRestartOptions[] = []
  const refusedPaths: string[] = []
  const io: RestartIssueIo = {
    logDir: LOG_DIR,
    isRefused: async (lockPath) => {
      refusedPaths.push(lockPath)
      return false
    },
    scheduleRestart: (options) => {
      scheduled.push(options)
    },
    ...overrides,
  }
  return { io, scheduled, refusedPaths }
}

afterEach(() => {
  vi.useRealTimers()
  endRestart()
})

describe('restartGuards', () => {
  it('profile 缺失时给 503', async () => {
    const { io, refusedPaths } = fakeIo()
    expect(await restartGuards(io, undefined, 3080)).toEqual({
      ok: false,
      status: 503,
      error: '取不到 profileContext，无法重启',
    })
    // profile 就不过，不必去查锁。
    expect(refusedPaths).toEqual([])
  })

  it('端口未知时给 503', async () => {
    const { io, refusedPaths } = fakeIo()
    expect(await restartGuards(io, TARGET, undefined)).toEqual({
      ok: false,
      status: 503,
      error: 'webServer 还没监听端口，无法重启',
    })
    expect(refusedPaths).toEqual([])
  })

  it('lock 存在时给 409', async () => {
    const { io, refusedPaths } = fakeIo({
      isRefused: async (lockPath) => {
        refusedPaths.push(lockPath)
        return true
      },
    })
    expect(await restartGuards(io, TARGET, 3080)).toEqual({
      ok: false,
      status: 409,
      error: '已有一个重启在进行中，等它结束再试',
    })
    expect(refusedPaths).toEqual([join(LOG_DIR, RESTART_LOCK_NAME)])
  })

  it('三项都正常时放行', async () => {
    const { io, refusedPaths } = fakeIo()
    expect(await restartGuards(io, TARGET, 3080)).toEqual({ ok: true })
    expect(refusedPaths).toEqual([join(LOG_DIR, RESTART_LOCK_NAME)])
  })

  it('判定顺序是 profile → port → lock，先报最前面那个', async () => {
    const { io, refusedPaths } = fakeIo({ isRefused: async () => true })
    expect(await restartGuards(io, undefined, undefined)).toMatchObject({ status: 503, error: '取不到 profileContext，无法重启' })
    expect(await restartGuards(io, TARGET, undefined)).toMatchObject({
      status: 503,
      error: 'webServer 还没监听端口，无法重启',
    })
    expect(refusedPaths).toEqual([])
  })

  it('isRefused 抛错时按「没有锁」放行（与旧路由行为一致）', async () => {
    const { io } = fakeIo({
      isRefused: async () => {
        throw new Error('EACCES')
      },
    })
    expect(await restartGuards(io, TARGET, 3080)).toEqual({ ok: true })
  })

  it('409 文案常量与守卫用的是同一句', () => {
    expect(RESTART_BUSY_ERROR).toBe('已有一个重启在进行中，等它结束再试')
  })
})

describe('armRestart', () => {
  it('armRestart 带上显式 dshHome 与 profileName', () => {
    const { io, scheduled } = fakeIo()
    armRestart(io, TARGET, 3080)
    expect(scheduled).toEqual([
      { port: 3080, profileDir: TARGET.dir, logDir: LOG_DIR, dshHome: TARGET.home, profileName: TARGET.name },
    ])
  })
})

describe('issueRestartLater', () => {
  it('只在延迟后派生一次', () => {
    vi.useFakeTimers()
    const { io, scheduled } = fakeIo()
    issueRestartLater(io, TARGET, 3080, 2500)

    expect(scheduled).toHaveLength(0)
    vi.advanceTimersByTime(2499)
    expect(scheduled).toHaveLength(0)
    vi.advanceTimersByTime(1)
    expect(scheduled).toEqual([
      { port: 3080, profileDir: TARGET.dir, logDir: LOG_DIR, dshHome: TARGET.home, profileName: TARGET.name },
    ])
    // 再等很久也不会派生第二次。
    vi.advanceTimersByTime(60_000)
    expect(scheduled).toHaveLength(1)
  })

  it('cancel 之后不派生', () => {
    vi.useFakeTimers()
    const { io, scheduled } = fakeIo()
    const handle = issueRestartLater(io, TARGET, 3080, 2500)
    handle.cancel()
    vi.advanceTimersByTime(60_000)
    expect(scheduled).toHaveLength(0)
  })

  it('cancel 幂等：派生之后再 cancel 不会撤销也不会重复派生', () => {
    vi.useFakeTimers()
    const { io, scheduled } = fakeIo()
    const handle = issueRestartLater(io, TARGET, 3080, 10)
    vi.advanceTimersByTime(10)
    expect(scheduled).toHaveLength(1)
    handle.cancel()
    handle.cancel()
    expect(scheduled).toHaveLength(1)
  })

  it('定时器 unref，不挡进程退出', () => {
    const unref = vi.fn()
    const timer = { unref } as unknown as NodeJS.Timeout
    const spy = vi.spyOn(globalThis, 'setTimeout').mockReturnValue(timer)
    try {
      const { io } = fakeIo()
      issueRestartLater(io, TARGET, 3080, 2500)
      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy.mock.calls[0]?.[1]).toBe(2500)
      expect(unref).toHaveBeenCalledTimes(1)
    } finally {
      spy.mockRestore()
    }
  })

  it('delayMs 非正数时按 0 处理，仍异步派生', () => {
    vi.useFakeTimers()
    const { io, scheduled } = fakeIo()
    issueRestartLater(io, TARGET, 3080, -5)
    expect(scheduled).toHaveLength(0)
    vi.advanceTimersByTime(0)
    expect(scheduled).toHaveLength(1)
  })
})

describe('进程级重启互斥', () => {
  it('第一次拿得到，第二次拿不到，释放后能再拿', () => {
    endRestart()
    expect(tryBeginRestart()).toBe(true)
    expect(tryBeginRestart()).toBe(false)
    endRestart()
    expect(tryBeginRestart()).toBe(true)
    endRestart()
  })

  it('endRestart 幂等', () => {
    endRestart()
    endRestart()
    expect(tryBeginRestart()).toBe(true)
    endRestart()
  })
})
