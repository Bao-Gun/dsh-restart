import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  RESTART_LOCK_NAME,
  isRefused,
  pickRoute,
  runRestartHelper,
  scheduleRestart,
  waitForPort,
} from '../src/server/restart'
import type { DaemonRestartHandle, HelperDeps, StartWebOptions } from '../src/server/restart'
import { helperMain, parseHelperConfig } from '../src/helper/restart'

type Exit = { code: number | null; signal: string | null; error?: string }

let dir = ''
const dirs: string[] = []

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-restart-t5-'))
  dirs.push(dir)
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

afterAll(async () => {
  await Promise.all(dirs.map((path) => rm(path, { recursive: true, force: true })))
})

function profileDir(): string {
  return join(dir, 'profiles', 'web')
}

/** 虚拟时钟：now 返回可控值，sleep 只推进时间，不真等。 */
function virtualClock(start = 1_000_000) {
  const clock = {
    t: start,
    now: () => clock.t,
    sleep: async (ms: number) => {
      clock.t += ms
    },
  }
  return clock
}

/** 按顺序返回预设值，用完之后一直返回最后一个值。 */
function sequenceProbe(values: boolean[]): { probe: (port: number) => Promise<boolean>; calls: () => number } {
  let index = 0
  return {
    probe: async () => {
      const value = values[Math.min(index, values.length - 1)] ?? false
      index += 1
      return value
    },
    calls: () => index,
  }
}

/** 造一个假的 dsh-daemon restart 句柄。 */
function daemonExits(exit: Exit | 'never'): () => DaemonRestartHandle {
  return () => ({
    exited: exit === 'never' ? new Promise<Exit>(() => {}) : Promise.resolve(exit),
  })
}

/** 读出本测试临时目录里所有 helper 日志的行。 */
async function logLines(): Promise<string[]> {
  const names = (await readdir(dir)).filter((name) => name.startsWith('helper-') && name.endsWith('.log'))
  const texts = await Promise.all(names.map((name) => readFile(join(dir, name), 'utf8')))
  return texts.flatMap((text) => text.trim().split('\n')).filter((line) => line !== '')
}

describe('pickRoute', () => {
  it('daemon 已装且没被暂停时首选 daemon', () => {
    expect(pickRoute(true, false)).toBe('daemon')
  })

  it('daemon 未安装或已暂停时退回 helper', () => {
    expect(pickRoute(false, false)).toBe('helper')
    expect(pickRoute(true, true)).toBe('helper')
    expect(pickRoute(false, true)).toBe('helper')
  })
})

describe('isRefused', () => {
  it('锁不存在时不算拒绝', async () => {
    expect(await isRefused(join(dir, RESTART_LOCK_NAME))).toBe(false)
  })

  it('锁存在时视为拒绝', async () => {
    await writeFile(join(dir, RESTART_LOCK_NAME), '{"pid":1}')
    expect(await isRefused(join(dir, RESTART_LOCK_NAME))).toBe(true)
  })
})

describe('waitForPort', () => {
  it('探活一直失败时返回 false，耗时不超过上界太多', async () => {
    const started = Date.now()
    const ok = await waitForPort(3080, 200, async () => false)
    const elapsed = Date.now() - started
    expect(ok).toBe(false)
    expect(elapsed).toBeGreaterThanOrEqual(150)
    expect(elapsed).toBeLessThan(700)
  })

  it('探活成功后立刻返回 true，不再多探', async () => {
    let calls = 0
    const ok = await waitForPort(3080, 2_000, async () => {
      calls += 1
      return calls >= 2
    })
    expect(ok).toBe(true)
    expect(calls).toBe(2)
  })

  it('timeout 为 0 时只探一次', async () => {
    let calls = 0
    const ok = await waitForPort(3080, 0, async () => {
      calls += 1
      return false
    })
    expect(ok).toBe(false)
    expect(calls).toBe(1)
  })

  it('probe 抛错按不可用处理，不向外抛', async () => {
    const ok = await waitForPort(3080, 100, async () => {
      throw new Error('boom')
    })
    expect(ok).toBe(false)
  })
})

describe('scheduleRestart', () => {
  it('用当前 node 拉起 detached 的 helper，并把配置塞进环境变量', () => {
    type SpawnOptions = { detached: boolean; stdio: 'ignore'; env: NodeJS.ProcessEnv }
    const calls: { command: string; args: string[]; options: SpawnOptions }[] = []
    let unrefs = 0

    scheduleRestart(
      { port: 3080, profileDir: '/home/u/.dsh/profiles/web', logDir: '/home/u/.dsh/dsh-restart' },
      {
        helperPath: '/opt/plugin/lib/helper.js',
        env: { PATH: '/usr/bin' },
        spawn: (command, args, options) => {
          calls.push({ command, args, options })
          return {
            unref: () => {
              unrefs += 1
            },
          }
        },
      },
    )

    expect(calls).toHaveLength(1)
    expect(calls[0]?.command).toBe(process.execPath)
    expect(calls[0]?.args).toEqual(['/opt/plugin/lib/helper.js'])
    expect(calls[0]?.options.detached).toBe(true)
    expect(calls[0]?.options.stdio).toBe('ignore')
    expect(calls[0]?.options.env).toMatchObject({
      PATH: '/usr/bin',
      DSH_RESTART_PORT: '3080',
      DSH_RESTART_PROFILE: '/home/u/.dsh/profiles/web',
      DSH_RESTART_LOG_DIR: '/home/u/.dsh/dsh-restart',
      DSH_RESTART_WEB_PID: String(process.pid),
    })
    expect(unrefs).toBe(1)
  })

  it('spawn 失败时只报错不外抛（路由此时已回 202）', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(() =>
        scheduleRestart(
          { port: 3080, profileDir: '/p', logDir: '/l' },
          {
            helperPath: '/h.js',
            spawn: () => {
              throw new Error('boom')
            },
          },
        ),
      ).not.toThrow()
      expect(error).toHaveBeenCalledTimes(1)
    } finally {
      error.mockRestore()
    }
  })
})

describe('runRestartHelper', () => {
  it('daemon 路径：观察到端口先掉后回时返回 0，并写规范日志、释放锁', async () => {
    const clock = virtualClock()
    const { probe } = sequenceProbe([true, false, true])

    const code = await runRestartHelper(
      { port: 3080, profileDir: profileDir(), logDir: dir, waitMs: 60_000 },
      {
        probe,
        now: clock.now,
        sleep: clock.sleep,
        pollMs: 250,
        startDaemonRestart: daemonExits({ code: 0, signal: null }),
        startWeb: () => {
          throw new Error('daemon 成功时不该自拉起')
        },
      },
    )

    expect(code).toBe(0)
    const lines = await logLines()
    expect(lines.some((line) => line.includes('port before: up'))).toBe(true)
    expect(lines.some((line) => line.includes('port: down'))).toBe(true)
    expect(lines.some((line) => line.includes('dsh-daemon restart 退出 code=0'))).toBe(true)
    expect(lines.some((line) => line.includes('web healthy on port 3080'))).toBe(true)
    for (const line of lines) {
      expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T\S+ \[pid \d+\] /)
    }
    expect((await readdir(dir)).includes(RESTART_LOCK_NAME)).toBe(false)
  })

  it('daemon 明确失败且端口已掉：自拉起并等 /health 回来，返回 0', async () => {
    const clock = virtualClock()
    const { probe } = sequenceProbe([true, false, false, false, true])
    const starts: StartWebOptions[] = []

    const code = await runRestartHelper(
      { port: 3080, profileDir: profileDir(), logDir: dir, waitMs: 60_000 },
      {
        probe,
        now: clock.now,
        sleep: clock.sleep,
        pollMs: 250,
        startDaemonRestart: daemonExits({ code: 1, signal: null }),
        startWeb: (options) => {
          starts.push(options)
          return { pid: 4321 }
        },
      },
    )

    expect(code).toBe(0)
    expect(starts).toHaveLength(1)
    expect(starts[0]?.profileName).toBe('web')
    expect(starts[0]?.port).toBe(3080)
    expect(starts[0]?.env.DSH_DAEMON_OPEN_BROWSER).toBe('0')
    expect(starts[0]?.env.DSH_HOME).toBe(dir)
    const lines = await logLines()
    expect(lines.some((line) => line.includes('自拉起：dsh web --profile web --port 3080 --no-open'))).toBe(true)
    expect(lines.some((line) => line.includes('web healthy on port 3080'))).toBe(true)
  })

  it('daemon 一直不退出且端口不回来：超时后自拉起，仍未健康则返回 1', async () => {
    const clock = virtualClock()
    const { probe, calls } = sequenceProbe([false])

    const code = await runRestartHelper(
      { port: 3080, profileDir: profileDir(), logDir: dir, waitMs: 60_000 },
      {
        probe,
        now: clock.now,
        sleep: clock.sleep,
        pollMs: 250,
        startDaemonRestart: daemonExits('never'),
        startWeb: () => ({ pid: 111 }),
      },
    )

    expect(code).toBe(1)
    expect(calls()).toBeGreaterThan(300)
    const lines = await logLines()
    expect(lines.some((line) => line.includes('未在 60000ms 内退出'))).toBe(true)
    expect(lines.some((line) => line.includes('未返回 200'))).toBe(true)
  })

  it('daemon 退出 0 但端口一直没掉（15s 内刚启动过）：不自拉起，返回 1', async () => {
    const clock = virtualClock()
    const { probe } = sequenceProbe([true, true])

    const code = await runRestartHelper(
      { port: 3080, profileDir: profileDir(), logDir: dir, waitMs: 60_000 },
      {
        probe,
        now: clock.now,
        sleep: clock.sleep,
        pollMs: 250,
        startDaemonRestart: daemonExits({ code: 0, signal: null }),
        startWeb: () => {
          throw new Error('daemon 跳过重启时不该自拉起')
        },
      },
    )

    expect(code).toBe(1)
    const lines = await logLines()
    expect(lines.some((line) => line.includes('跳过了重启'))).toBe(true)
  })

  it('daemon 失败但旧 web 还活着：SIGTERM 旧进程、等端口掉下去、再自拉起', async () => {
    const clock = virtualClock()
    const { probe } = sequenceProbe([true, true, true, false, false, true])
    const killed: number[] = []
    let starts = 0

    const code = await runRestartHelper(
      { port: 3080, profileDir: profileDir(), logDir: dir, waitMs: 60_000, webPid: process.pid },
      {
        probe,
        now: clock.now,
        sleep: clock.sleep,
        pollMs: 250,
        startDaemonRestart: daemonExits({ code: 1, signal: null }),
        killWeb: (pid) => {
          killed.push(pid)
        },
        startWeb: () => {
          starts += 1
          return { pid: 99 }
        },
      },
    )

    expect(code).toBe(0)
    expect(killed).toEqual([process.pid])
    expect(starts).toBe(1)
  })

  it('daemon 失败、端口仍健康且没有可用的 web PID：放弃自拉起，返回 1', async () => {
    const clock = virtualClock()
    const { probe } = sequenceProbe([true, true, true])

    const code = await runRestartHelper(
      { port: 3080, profileDir: profileDir(), logDir: dir, waitMs: 60_000 },
      {
        probe,
        now: clock.now,
        sleep: clock.sleep,
        pollMs: 250,
        startDaemonRestart: daemonExits({ code: 1, signal: null }),
        startWeb: () => {
          throw new Error('拿不到 web PID 时不该自拉起')
        },
      },
    )

    expect(code).toBe(1)
    const lines = await logLines()
    expect(lines.some((line) => line.includes('接管失败'))).toBe(true)
  })

  it('残留锁（修改时间超过 10 分钟）会被清掉后继续重启', async () => {
    const lockPath = join(dir, RESTART_LOCK_NAME)
    await writeFile(lockPath, JSON.stringify({ at: new Date().toISOString() }))
    const old = new Date(Date.now() - 11 * 60_000)
    await utimes(lockPath, old, old)

    const clock = virtualClock()
    const { probe } = sequenceProbe([true, false, true])

    const code = await runRestartHelper(
      { port: 3080, profileDir: profileDir(), logDir: dir, waitMs: 60_000 },
      {
        probe,
        now: clock.now,
        sleep: clock.sleep,
        pollMs: 250,
        startDaemonRestart: daemonExits({ code: 0, signal: null }),
      },
    )

    expect(code).toBe(0)
    expect((await readdir(dir)).includes(RESTART_LOCK_NAME)).toBe(false)
    expect((await logLines()).some((line) => line.includes('清理残留锁文件'))).toBe(true)
  })

  it('锁被活着进程持有时拒绝重启，不碰 daemon', async () => {
    const lockPath = join(dir, RESTART_LOCK_NAME)
    await writeFile(lockPath, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))
    let daemonCalls = 0

    const code = await runRestartHelper(
      { port: 3080, profileDir: profileDir(), logDir: dir, waitMs: 60_000 },
      {
        probe: async () => {
          throw new Error('被拒绝时不该探活')
        },
        startDaemonRestart: () => {
          daemonCalls += 1
          return { exited: Promise.resolve({ code: 0, signal: null }) }
        },
      },
    )

    expect(code).toBe(1)
    expect(daemonCalls).toBe(0)
    expect((await logLines()).some((line) => line.includes('refused'))).toBe(true)
  })
})

describe('parseHelperConfig', () => {
  it('解析合法环境变量', () => {
    const parsed = parseHelperConfig({
      DSH_RESTART_PORT: '3080',
      DSH_RESTART_PROFILE: '/home/u/.dsh/profiles/web',
      DSH_RESTART_LOG_DIR: '/tmp/dsh-restart-logs',
      DSH_RESTART_WAIT_MS: '5000',
      DSH_RESTART_WEB_PID: '42',
    })
    expect(parsed).toEqual({
      ok: true,
      config: {
        port: 3080,
        profileDir: '/home/u/.dsh/profiles/web',
        logDir: '/tmp/dsh-restart-logs',
        waitMs: 5000,
        webPid: 42,
      },
    })
  })

  it('端口缺失或非法时给出错误', () => {
    const cases = [
      {},
      { DSH_RESTART_PORT: '', DSH_RESTART_PROFILE: '/p' },
      { DSH_RESTART_PORT: 'abc', DSH_RESTART_PROFILE: '/p' },
      { DSH_RESTART_PORT: '0', DSH_RESTART_PROFILE: '/p' },
      { DSH_RESTART_PORT: '70000', DSH_RESTART_PROFILE: '/p' },
      { DSH_RESTART_PORT: '3080.5', DSH_RESTART_PROFILE: '/p' },
    ]
    for (const env of cases) {
      expect(parseHelperConfig(env).ok, JSON.stringify(env)).toBe(false)
    }
  })

  it('profile 缺失时给出错误', () => {
    expect(parseHelperConfig({ DSH_RESTART_PORT: '3080' }).ok).toBe(false)
  })

  it('日志目录缺省到 ~/.dsh/dsh-restart', () => {
    const parsed = parseHelperConfig({ DSH_RESTART_PORT: '3080', DSH_RESTART_PROFILE: '/p' })
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.config.logDir).toBe(join(homedir(), '.dsh', 'dsh-restart'))
  })
})

describe('helperMain', () => {
  it('从环境读配置并跑完整流程', async () => {
    const clock = virtualClock()
    const { probe } = sequenceProbe([true, false, true])
    const messages: string[] = []
    const logDir = join(dir, 'logs')

    const code = await helperMain({
      env: {
        DSH_RESTART_PORT: '3080',
        DSH_RESTART_PROFILE: profileDir(),
        DSH_RESTART_LOG_DIR: logDir,
        DSH_RESTART_WAIT_MS: '60000',
      },
      stderr: (text) => {
        messages.push(text)
      },
      deps: {
        probe,
        now: clock.now,
        sleep: clock.sleep,
        pollMs: 250,
        startDaemonRestart: daemonExits({ code: 0, signal: null }),
        startWeb: () => {
          throw new Error('不该自拉起')
        },
      },
    })

    expect(code).toBe(0)
    expect(messages).toEqual([])
    const names = await readdir(logDir)
    expect(names.some((name) => name.startsWith('helper-') && name.endsWith('.log'))).toBe(true)
    expect(names.includes(RESTART_LOCK_NAME)).toBe(false)
  })

  it('配置错误时返回 1 并写 stderr', async () => {
    const messages: string[] = []
    const code = await helperMain({
      env: {},
      stderr: (text) => {
        messages.push(text)
      },
    })
    expect(code).toBe(1)
    expect(messages.join('')).toContain('DSH_RESTART_PORT')
  })
})
