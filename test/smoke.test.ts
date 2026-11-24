import { execFileSync, spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  CLONE_TIMEOUT_MS,
  COPY_TIMEOUT_MS,
  cleanupStaleSmokeDirs,
  cloneAttemptTimeoutMs,
  describeCloneAttempt,
  diffFailedEntries,
  killProcessTree,
  parseNotActivated,
  parsePsIdentity,
} from '../src/server/smoke'
import type { CommandOutcome } from '../src/server/smoke'

/** 宿主 dsh-app-boot 的可选条目告警原文形状（activationDiagnostic）。 */
const WARNING_STDERR = [
  'dsh web: warning: 2 entries did not activate',
  'dsh-tools (dsh-tools): failed to import: Cannot find module \'x\'',
  'plugin-x (@scope/plugin-x): pending (waiting for services: loader, shell)',
  'dsh web: opening the default browser; pass --no-open to disable',
].join('\n')

/** 必需条目失败时宿主走 startupDiagnostic，形状与可选告警不同。 */
const STARTUP_FAILED_STDERR = [
  'dsh web: startup failed: 2 required plugins did not activate',
  '',
  'Failed plugins (2):',
  '  alpha',
  '    Package: @scope/alpha',
  '    failed to import: boom',
  '  beta (required)',
  '    Package: @scope/beta',
  '    failed to import: boom',
].join('\n')

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0)
    return true
  } catch {
    return false
  }
}

/** 把目录 mtime 拨老，绕过「年轻目录视为在飞」的保护。 */
async function makeOld(dir: string): Promise<void> {
  const past = new Date(Date.now() - 60_000)
  await utimes(dir, past, past)
}

function psIdentity(pid: number): { lstart: string; command: string } | null {
  try {
    const text = execFileSync('ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'command='], {
      encoding: 'utf8',
      // 跟生产代码一样钉住 C 语言环境：zh_CN 下 ps 的日期格式不同，解析不出身份。
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
    })
    // 直接复用被测解析：测试取的 ps 样本与生产走同一条正则，不另抄一份
    return parsePsIdentity(text)
  } catch {
    return null
  }
}

async function waitForPs(pid: number): Promise<{ lstart: string; command: string }> {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    const identity = psIdentity(pid)
    if (identity !== null) return identity
    await new Promise((resolveWait) => setTimeout(resolveWait, 50))
  }
  throw new Error('拿不到进程 ' + String(pid) + ' 的 ps 身份')
}

describe('parseNotActivated', () => {
  it('从可选条目告警里抽出两个条目 id，忽略其它 warning', () => {
    expect(parseNotActivated(WARNING_STDERR)).toEqual(['dsh-tools', 'plugin-x'])
  })

  it('兼容必需条目失败的 startupDiagnostic 块，并去掉 (required) 标记', () => {
    expect(parseNotActivated(STARTUP_FAILED_STDERR)).toEqual(['alpha', 'beta'])
  })

  it('同一个条目出现多次只保留第一次', () => {
    const stderr = [
      'dsh web: warning: 2 entries did not activate',
      'dup (pkg): failed to import: boom',
      'dup (pkg): failed to import: boom',
    ].join('\n')

    expect(parseNotActivated(stderr)).toEqual(['dup'])
  })

  it('没有 did not activate 标记时不误抓普通告警里的括号行', () => {
    const stderr = [
      'dsh: [/tmp/profile/cordis.patch.yml] patch: entry "mcp-connector" not found',
      'dsh web: listening on 127.0.0.1 over plain HTTP',
      'some (thing): not an activation diagnostic',
    ].join('\n')

    expect(parseNotActivated(stderr)).toEqual([])
  })

  it('宿主只报一条未激活时用单数 entry，也要抓到', () => {
    const stderr = [
      'dsh: warning: 1 entry did not activate',
      'restart-button (dsh-restart): failed to import: boom',
    ].join('\n')

    expect(parseNotActivated(stderr)).toEqual(['restart-button'])
  })

  it('有标记时只收紧跟告警头的诊断行，同屏无关括号行不算条目', () => {
    const stderr = [
      'dsh web: warning: 1 entries did not activate',
      'dsh-tools (dsh-tools): failed to import: boom',
      '',
      'some (thing): not an activation diagnostic',
    ].join('\n')

    expect(parseNotActivated(stderr)).toEqual(['dsh-tools'])
  })

  it('空串与只有换行的串返回空数组', () => {
    expect(parseNotActivated('')).toEqual([])
    expect(parseNotActivated('\n\n')).toEqual([])
  })
})

describe('diffFailedEntries', () => {
  it('当前比基线多出的条目算 added', () => {
    expect(diffFailedEntries(['a', 'b'], ['b'])).toEqual({ added: ['a'], removed: [] })
  })

  it('基线和当前都空时两边都空', () => {
    expect(diffFailedEntries([], [])).toEqual({ added: [], removed: [] })
  })

  it('基线里有、这次没失败的条目算 removed（仅展示用，不阻断）', () => {
    expect(diffFailedEntries(['b'], ['a', 'b'])).toEqual({ added: [], removed: ['a'] })
  })

  it('两边都去重，并保持各自原有顺序', () => {
    expect(diffFailedEntries(['b', 'a', 'b'], ['a', 'a'])).toEqual({
      added: ['b'],
      removed: [],
    })
    expect(diffFailedEntries(['a'], ['b', 'b', 'c'])).toEqual({
      added: ['a'],
      removed: ['b', 'c'],
    })
  })
})

describe('parsePsIdentity', () => {
  it('解析 macOS C locale 的 lstart 与完整 command', () => {
    // 本机 macOS 实采形态
    expect(
      parsePsIdentity(
        'Mon Nov 24 10:31:59 2026 /usr/local/bin/node /usr/local/bin/dsh --profile web --port 0 --no-open',
      ),
    ).toEqual({
      lstart: 'Mon Nov 24 10:31:59 2026',
      command: '/usr/local/bin/node /usr/local/bin/dsh --profile web --port 0 --no-open',
    })
  })

  it('Linux（Debian NAS）同形样本一样解析', () => {
    // NAS 上 LC_ALL=C 实采：'Tue Nov 24 10:31:59 2026 ...'
    expect(
      parsePsIdentity(
        'Tue Nov 24 10:31:59 2026 /usr/bin/node /usr/lib/node_modules/dsh/bin/dsh --profile web',
      ),
    ).toEqual({
      lstart: 'Tue Nov 24 10:31:59 2026',
      command: '/usr/bin/node /usr/lib/node_modules/dsh/bin/dsh --profile web',
    })
  })

  it('zh_CN 的「一 11/23 22:40:14 2026」形态返回 null，调用方按「无法确认」处理', () => {
    expect(
      parsePsIdentity('  一 11/23 22:40:14 2026 /usr/local/bin/node /usr/local/bin/dsh web'),
    ).toBeNull()
  })

  it('空串与只有空白的串返回 null', () => {
    expect(parsePsIdentity('')).toBeNull()
    expect(parsePsIdentity(' \n ')).toBeNull()
  })

  it('有 lstart 但没有 command 时返回 null', () => {
    expect(parsePsIdentity('Mon Nov 24 10:31:59 2026')).toBeNull()
  })

  it('stdout 自带的尾部换行不影响解析', () => {
    expect(parsePsIdentity('Mon Nov 24 10:31:59 2026 /usr/local/bin/node dsh web\n')).toEqual({
      lstart: 'Mon Nov 24 10:31:59 2026',
      command: '/usr/local/bin/node dsh web',
    })
  })
})

describe('killProcessTree', () => {
  it.skipIf(process.platform === 'win32')(
    '组长已退出时仍会杀掉同组残留成员',
    async () => {
      const child = spawn('sh', ['-c', 'sleep 30 & exit 1'], {
        detached: true,
        stdio: 'ignore',
      })
      const pid = child.pid
      expect(pid).toBeTypeOf('number')

      await new Promise<void>((resolveExit) => {
        child.once('exit', () => resolveExit())
      })
      // 组长（sh）已经退出，但后台 sleep 还在同一个进程组里
      expect(groupAlive(pid!)).toBe(true)

      const cleaned = await killProcessTree(child)
      expect(cleaned).toBe(true)
      expect(groupAlive(pid!)).toBe(false)
    },
    15_000,
  )
})

describe('cleanupStaleSmokeDirs', () => {
  it('父进程已死的旧目录清掉，父进程仍活的目录保留', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-smoke-cleanup-'))
    try {
      const deadDir = join(root, 'dsh-smoke-dead')
      await mkdir(deadDir)
      await writeFile(join(deadDir, 'run.pid'), '999999')
      await makeOld(deadDir)

      const aliveDir = join(root, 'dsh-smoke-alive')
      await mkdir(aliveDir)
      await writeFile(join(aliveDir, 'run.pid'), String(process.pid))
      await makeOld(aliveDir)

      const result = await cleanupStaleSmokeDirs(root)

      expect(result.removed).toEqual(['dsh-smoke-dead'])
      expect(result.failures).toEqual([])
      await expect(stat(deadDir)).rejects.toBeTruthy()
      await expect(stat(aliveDir)).resolves.toBeTruthy()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('没有 run.pid 的旧目录直接删掉', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-smoke-cleanup-'))
    try {
      const dir = join(root, 'dsh-smoke-nopid')
      await mkdir(dir)
      await writeFile(join(dir, 'dsh.json'), 'not even valid json')
      await makeOld(dir)

      const result = await cleanupStaleSmokeDirs(root)

      expect(result.removed).toEqual(['dsh-smoke-nopid'])
      expect(result.failures).toEqual([])
      await expect(stat(dir)).rejects.toBeTruthy()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('刚创建的在飞目录不会被清扫', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-smoke-cleanup-'))
    try {
      const dir = join(root, 'dsh-smoke-fresh')
      await mkdir(dir)
      await writeFile(join(dir, 'run.pid'), '999999')

      const result = await cleanupStaleSmokeDirs(root)

      expect(result.removed).toEqual([])
      expect(result.failures).toEqual([])
      await expect(stat(dir)).resolves.toBeTruthy()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')(
    '身份对不上时只删目录，不给进程组发信号',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'dsh-smoke-cleanup-'))
      const child = spawn('sh', ['-c', 'sleep 30'], { detached: true, stdio: 'ignore' })
      const pid = child.pid
      expect(pid).toBeTypeOf('number')
      try {
        const current = await waitForPs(pid!)
        const dir = join(root, 'dsh-smoke-mismatch')
        await mkdir(dir)
        await writeFile(
          join(dir, 'dsh.json'),
          JSON.stringify({
            pid,
            // lstart 和 command 都伪造：就算 pid 活着也不能确认是试跑实例
            lstart: 'Sun Jan  1 00:00:00 1970',
            command: '/usr/local/bin/dsh web',
          }),
        )
        await makeOld(dir)
        expect(current.command).not.toBe('/usr/local/bin/dsh web')

        const result = await cleanupStaleSmokeDirs(root)

        expect(result.removed).toEqual(['dsh-smoke-mismatch'])
        expect(result.failures).toEqual([])
        expect(groupAlive(pid!)).toBe(true)
        await expect(stat(dir)).rejects.toBeTruthy()
      } finally {
        try {
          process.kill(-pid!, 'SIGKILL')
        } catch {
          // 已退出
        }
        await rm(root, { recursive: true, force: true })
      }
    },
    15_000,
  )

  it.skipIf(process.platform === 'win32')(
    '身份匹配时杀掉旧试跑实例的进程组',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'dsh-smoke-cleanup-'))
      const script = join(root, 'dsh')
      await writeFile(script, '#!/bin/sh\nsleep 30\n', { mode: 0o755 })
      const child = spawn(script, [], { detached: true, stdio: 'ignore' })
      const pid = child.pid
      expect(pid).toBeTypeOf('number')
      try {
        const identity = await waitForPs(pid!)
        expect(identity.command).toContain('dsh')

        const dir = join(root, 'dsh-smoke-kill')
        await mkdir(dir)
        await writeFile(join(dir, 'dsh.json'), JSON.stringify({ pid, ...identity }))
        await makeOld(dir)

        const result = await cleanupStaleSmokeDirs(root)

        expect(result.removed).toEqual(['dsh-smoke-kill'])
        expect(result.failures).toEqual([])
        expect(groupAlive(pid!)).toBe(false)
        await expect(stat(dir)).rejects.toBeTruthy()
      } finally {
        try {
          process.kill(-pid!, 'SIGKILL')
        } catch {
          // 已退出
        }
        await rm(root, { recursive: true, force: true })
      }
    },
    15_000,
  )

  it('非 dsh-smoke- 前缀目录不动', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-smoke-cleanup-'))
    try {
      const dir = join(root, 'other-dir')
      await mkdir(dir)
      await makeOld(dir)

      const result = await cleanupStaleSmokeDirs(root)

      expect(result.removed).toEqual([])
      expect(result.failures).toEqual([])
      await expect(stat(dir)).resolves.toBeTruthy()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('冒烟克隆：超时预算与失败文案', () => {
  it('只有 macOS clonefile 算快路径；reflink 在 ext4 会静默退化成整拷，只能按整拷预算', () => {
    expect(COPY_TIMEOUT_MS).toBeGreaterThan(CLONE_TIMEOUT_MS)
    expect(cloneAttemptTimeoutMs(['-c', '-R', 'a', 'b'])).toBe(CLONE_TIMEOUT_MS)
    expect(cloneAttemptTimeoutMs(['--reflink=auto', '-R', 'a', 'b'])).toBe(COPY_TIMEOUT_MS)
    expect(cloneAttemptTimeoutMs(['-R', 'a', 'b'])).toBe(COPY_TIMEOUT_MS)
  })

  it('超时单独标「克隆超时（N ms）」；非超时带自己的退出码与 stderr', () => {
    const timedOut: CommandOutcome = {
      code: null,
      stdout: '',
      stderr: '',
      timedOut: true,
      spawnError: null,
    }
    const exited: CommandOutcome = {
      code: 1,
      stdout: '',
      stderr: "cp: invalid option -- 'c'",
      timedOut: false,
      spawnError: null,
    }

    const timeoutText = describeCloneAttempt(['--reflink=auto', '-R', 'a', 'b'], timedOut, COPY_TIMEOUT_MS)
    expect(timeoutText).toBe('cp --reflink=auto -R：克隆超时（120000 ms）')
    expect(timeoutText).not.toContain('退出码')

    const exitText = describeCloneAttempt(['-c', '-R', 'a', 'b'], exited, CLONE_TIMEOUT_MS)
    expect(exitText).toBe("cp -c -R：退出码 1：cp: invalid option -- 'c'")
    expect(exitText).not.toContain('克隆超时')
  })
})
