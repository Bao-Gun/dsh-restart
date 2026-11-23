import { execFile, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

import type { Failure } from '../shared/types'

/**
 * 预检 C：克隆当前 profile 到临时 DSH_HOME，另起一个 dsh web，等 /health，收未激活名单。
 *
 * 两个安全点：
 * - 克隆必须用 APFS clonefile（cp -c）。硬链接会共享 inode，试跑写日志/auth 会写进线上 profile。
 * - 无论成功失败，finally 里都要杀掉整个进程组并删掉临时目录，不能留孤儿进程。
 */

const execFileAsync = promisify(execFile)

/** 实测克隆后首次启动约 5.2s，8s 太紧；12s 仍属 8 秒级，且给并发构建留余量。 */
const DEFAULT_SMOKE_TIMEOUT_MS = 12_000
const DUMP_CONFIG_TIMEOUT_MS = 20_000
const CLONE_TIMEOUT_MS = 60_000
const COPY_TIMEOUT_MS = 120_000
const HEALTH_POLL_INTERVAL_MS = 150
const KILL_GRACE_MS = 2_000
const KILL_KILL_GRACE_MS = 1_000
/** 告警在启动早期，留开头；截断只防异常输出撑爆内存。 */
const STDERR_LIMIT = 256 * 1024
const STDOUT_LIMIT = 64 * 1024
const MAX_BUFFER = 8 * 1024 * 1024
const HEALTH_PROBE_TIMEOUT_MS = 1_500
/** 只认 web 自己那行 URL；devtools 的 ws=127.0.0.1:9231 不能被当成监听端口。 */
const WEB_URL_LINE = /dsh web:\s+(https?:\/\/[^\s]+)/

const ACTIVATION_MARKER = 'did not activate'
/** 可选条目告警：<entry id> (<package>): <detail> */
const DIAGNOSTIC_LINE = /^(\S+) \(([^()]*)\): /
/** 必需条目失败块：两空格缩进的 id，下一行才是 Package。 */
const STARTUP_FAILED_LINE = /^ {2}(\S+?)(?: \(required\))?$/
const STARTUP_PACKAGE_LINE = /^ {4}Package: /

export interface SmokeOptions {
  profileDir: string
  /** 调用方给的临时根目录；冒烟只在自己建的子目录里折腾，不删 tmpRoot 本身。 */
  tmpRoot: string
  timeoutMs?: number
}

export interface SmokeResult {
  /** 只表示 /health 200；是否「通过」要由调用方结合基线差分判断。 */
  ok: boolean
  /** 启动失败、克隆失败这类硬失败；未激活名单不算失败。 */
  failures: Failure[]
  /** stderr 里本次未激活的条目 id，交给 diffFailedEntries 比基线。 */
  failedEntries: string[]
  durationMs: number
}

interface CommandOutcome {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  spawnError: string | null
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function appendCapped(current: string, chunk: string, limit: number): string {
  const next = current + chunk
  return next.length > limit ? next.slice(0, limit) : next
}

function tail(text: string, limit = 500): string {
  const trimmed = text.trim()
  if (trimmed === '') return ''
  return trimmed.length > limit ? '…' + trimmed.slice(-limit) : trimmed
}

function describeCommand(outcome: CommandOutcome): string {
  if (outcome.spawnError !== null) return '启动失败：' + outcome.spawnError
  if (outcome.timedOut) return '超时'
  const detail = tail(outcome.stderr)
  return '退出码 ' + String(outcome.code) + (detail === '' ? '' : '：' + detail)
}

/** 跑一个会自己退出的命令（cp / dump-config），超时会杀掉它。 */
async function runCommand(
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<CommandOutcome> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      env: options.env ?? process.env,
      timeout: options.timeoutMs,
      maxBuffer: MAX_BUFFER,
      encoding: 'utf8',
    })
    return { code: 0, stdout, stderr, timedOut: false, spawnError: null }
  } catch (error) {
    const failure = error as {
      code?: number | string
      killed?: boolean
      message?: string
      stdout?: string
      stderr?: string
    }
    const spawnError = typeof failure.code === 'string' ? (failure.message ?? 'spawn failed') : null
    return {
      code: typeof failure.code === 'number' ? failure.code : null,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
      timedOut: failure.killed === true,
      spawnError,
    }
  }
}

/**
 * 从 stderr 里抽「本次没激活」的条目 id 名单。
 *
 * 宿主有两种格式：
 * - 可选条目：'dsh web: warning: N entries did not activate' 后跟 'id (pkg): detail' 若干行；
 * - 必需条目：'dsh web: startup failed: ...' 下的 'Failed plugins' 块，id 单独一行、下一行是 'Package:'。
 * 没有 did not activate 标记时一律返回空，避免把别的告警误当未激活名单。
 */
export function parseNotActivated(stderr: string): string[] {
  if (!stderr.includes(ACTIVATION_MARKER)) return []

  const entries: string[] = []
  const seen = new Set<string>()
  const push = (id: string): void => {
    if (id === '' || seen.has(id)) return
    seen.add(id)
    entries.push(id)
  }

  const lines = stderr.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const diagnostic = DIAGNOSTIC_LINE.exec(line)
    if (diagnostic !== null) {
      push(diagnostic[1] ?? '')
      continue
    }
    const failed = STARTUP_FAILED_LINE.exec(line)
    if (failed !== null && STARTUP_PACKAGE_LINE.test(lines[index + 1] ?? '')) {
      push(failed[1] ?? '')
    }
  }
  return entries
}

function uniqueEntries(items: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const item of items) {
    if (seen.has(item)) continue
    seen.add(item)
    result.push(item)
  }
  return result
}

/**
 * 纯差分：added 是本次新增的失败条目（要红），removed 是基线里有、这次好了的条目（只展示）。
 *
 * 端口冲突这类「线上必然一直存在」的失败第一次会进 added，通过一次后写进 baseline，
 * 之后就只出现在 removed/交集里，不再阻断——这正是设计里「冲突进基线」的做法。
 */
export function diffFailedEntries(
  current: string[],
  baseline: string[],
): { added: string[]; removed: string[] } {
  const now = uniqueEntries(current)
  const before = uniqueEntries(baseline)
  const baselineSet = new Set(before)
  const currentSet = new Set(now)
  return {
    added: now.filter((entry) => !baselineSet.has(entry)),
    removed: before.filter((entry) => !currentSet.has(entry)),
  }
}

/**
 * 快检 A：'dsh --profile <name> --dump-config' 能合成配置并退出 0。
 * profileDir 的爷爷目录就是 DSH_HOME（~/.dsh/profiles/web），这样子进程不用猜环境变量。
 */
export async function runDumpConfig(profileDir: string): Promise<Failure[]> {
  const profile = resolve(profileDir)
  const profileName = basename(profile)
  const home = dirname(dirname(profile))

  const outcome = await runCommand('dsh', ['--profile', profileName, '--dump-config'], {
    env: { ...process.env, DSH_HOME: home },
    timeoutMs: DUMP_CONFIG_TIMEOUT_MS,
  })

  if (outcome.spawnError !== null) {
    return [
      {
        kind: 'config',
        message: '无法启动 dsh --dump-config：' + outcome.spawnError,
      },
    ]
  }
  if (outcome.timedOut) {
    return [
      {
        kind: 'config',
        message:
          'dsh --profile ' +
          profileName +
          ' --dump-config 在 ' +
          String(DUMP_CONFIG_TIMEOUT_MS) +
          'ms 内没有结束',
      },
    ]
  }
  if (outcome.code !== 0) {
    return [
      {
        kind: 'config',
        message: 'dsh --profile ' + profileName + ' --dump-config 失败（' + describeCommand(outcome) + '）',
      },
    ]
  }

  return parseNotActivated(outcome.stderr).map((entry) => ({
    kind: 'config',
    plugin: entry,
    message: 'dump-config 报告条目 ' + entry + ' 未激活',
  }))
}

/** 先试 APFS clonefile；文件系统不支持时退回真拷贝。目标一定在本次临时目录里。 */
async function cloneProfile(source: string, dest: string): Promise<Failure | null> {
  const cloned = await runCommand('cp', ['-c', '-R', source, dest], { timeoutMs: CLONE_TIMEOUT_MS })
  if (cloned.code === 0) return null

  // cp -c 失败时可能留下半个目标目录，重试前清掉
  await rm(dest, { recursive: true, force: true }).catch(() => undefined)
  const copied = await runCommand('cp', ['-R', source, dest], { timeoutMs: COPY_TIMEOUT_MS })
  if (copied.code === 0) return null

  return {
    kind: 'boot',
    message:
      '克隆 profile 失败：cp -c ' +
      describeCommand(cloned) +
      '；cp -R ' +
      describeCommand(copied),
  }
}

function portFromStdout(stdout: string): number | null {
  const line = WEB_URL_LINE.exec(stdout)
  if (line === null) return null
  try {
    const url = new URL(line[1] ?? '')
    const port = Number(url.port)
    return Number.isInteger(port) && port > 0 ? port : null
  } catch {
    return null
  }
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise((resolveExit) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit)
      resolveExit(false)
    }, timeoutMs)
    const onExit = (): void => {
      clearTimeout(timer)
      resolveExit(true)
    }
    child.once('exit', onExit)
  })
}

/** detached 后的子进程是新进程组组长，负 pid 一次带走它和它拉起的子进程。 */
async function killProcessTree(child: ChildProcess): Promise<boolean> {
  const pid = child.pid
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return true

  const signalGroup = (signal: NodeJS.Signals): boolean => {
    if (process.platform === 'win32') return false
    try {
      process.kill(-pid, signal)
      return true
    } catch {
      return false
    }
  }

  const exited = waitForExit(child, KILL_GRACE_MS)
  if (!signalGroup('SIGTERM')) {
    try {
      child.kill('SIGTERM')
    } catch {
      // 已经退出
    }
  }
  if (await exited) return true

  const killed = waitForExit(child, KILL_KILL_GRACE_MS)
  if (!signalGroup('SIGKILL')) {
    try {
      child.kill('SIGKILL')
    } catch {
      // 已经退出
    }
  }
  return killed
}

/** 起试跑实例、等 /health；无论结果如何都在 finally 里结束进程。 */
async function runWebInClone(
  tmpHome: string,
  profileName: string,
  timeoutMs: number,
): Promise<{ ok: boolean; failures: Failure[]; failedEntries: string[] }> {
  const bin = process.env.DSH_RESTART_DSH_BIN ?? 'dsh'
  const child = spawn(bin, ['--profile', profileName, '--port', '0', '--no-open'], {
    env: { ...process.env, DSH_HOME: tmpHome, DSH_DAEMON_OPEN_BROWSER: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  })

  let stdout = ''
  let stderr = ''
  // 数组而不是 let：TS 不追踪回调里的赋值，用 let 会在检查处被收窄成 null
  const spawnErrors: string[] = []
  const exitRecords: Array<{ code: number | null; signal: string | null }> = []
  let port: number | null = null
  let healthStatus: number | null = null
  let lastProbeError = ''
  let ok = false

  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    stdout = appendCapped(stdout, chunk, STDOUT_LIMIT)
  })
  child.stderr?.on('data', (chunk: string) => {
    stderr = appendCapped(stderr, chunk, STDERR_LIMIT)
  })
  child.once('error', (error) => {
    spawnErrors.push(messageOf(error))
  })
  // close 保证 stdout/stderr 都收完了；exit 更早但可能丢最后一段
  child.once('close', (code, signal) => {
    exitRecords.push({ code, signal })
  })

  const failures: Failure[] = []
  const deadline = Date.now() + timeoutMs
  try {
    while (Date.now() < deadline) {
      if (spawnErrors.length > 0 || exitRecords.length > 0) break
      if (port === null) {
        port = portFromStdout(stdout)
      }
      if (port !== null) {
        try {
          const response = await fetch('http://127.0.0.1:' + String(port) + '/health', {
            signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
          })
          healthStatus = response.status
          if (response.status === 200) {
            ok = true
            break
          }
        } catch (error) {
          lastProbeError = messageOf(error)
        }
      }
      await delay(HEALTH_POLL_INTERVAL_MS)
    }

    if (ok) {
      // 告警写在 URL 之前，但 stdout/stderr 是两个管道；等一拍确保最后一行已到
      await delay(100)
    } else if (spawnErrors.length > 0) {
      failures.push({
        kind: 'boot',
        message: '无法启动试跑实例（' + bin + '）：' + (spawnErrors[0] ?? ''),
      })
    } else if (exitRecords.length > 0) {
      const exitState = exitRecords[0]!
      const status =
        exitState.code !== null
          ? '退出码 ' + String(exitState.code)
          : '被信号 ' + (exitState.signal ?? 'unknown') + ' 结束'
      const detail = tail(stderr)
      failures.push({
        kind: 'boot',
        message: '试跑实例提前退出（' + status + '）' + (detail === '' ? '' : '：' + detail),
      })
    } else if (port === null) {
      const detail = tail(stderr)
      failures.push({
        kind: 'boot',
        message:
          '试跑实例在 ' +
          String(timeoutMs) +
          'ms 内没有打印 Web URL' +
          (detail === '' ? '' : '：' + detail),
      })
    } else {
      const probe = lastProbeError === '' ? '' : '，最后探活错误：' + lastProbeError
      failures.push({
        kind: 'boot',
        message:
          '试跑实例端口 ' +
          String(port) +
          ' 的 /health 在 ' +
          String(timeoutMs) +
          'ms 内未返回 200（最后状态：' +
          (healthStatus === null ? '无响应' : String(healthStatus)) +
          probe +
          '）',
      })
    }

    return { ok, failures, failedEntries: parseNotActivated(stderr) }
  } finally {
    const cleaned = await killProcessTree(child)
    if (!cleaned) {
      failures.push({
        kind: 'boot',
        message: '试跑实例（pid ' + String(child.pid) + '）在 SIGKILL 后仍未退出，可能留下孤儿进程',
      })
    }
  }
}

/**
 * 配置合成已在别处做过（runDumpConfig）；这里只负责「换个 DSH_HOME 真启动一次」。
 * ok 只代表 /health 200，未激活名单通过 failedEntries 返回。
 */
export async function runSmoke(options: SmokeOptions): Promise<SmokeResult> {
  const startedAt = Date.now()
  const profileDir = resolve(options.profileDir)
  const profileName = basename(profileDir)
  const timeoutMs = options.timeoutMs ?? DEFAULT_SMOKE_TIMEOUT_MS
  const failures: Failure[] = []
  let ok = false
  let failedEntries: string[] = []
  let tmpHome: string | null = null

  try {
    const tmpRoot = resolve(options.tmpRoot)
    await mkdir(tmpRoot, { recursive: true })
    tmpHome = await mkdtemp(join(tmpRoot, 'dsh-smoke-'))
    await mkdir(join(tmpHome, 'profiles'), { recursive: true })

    const clonedProfile = join(tmpHome, 'profiles', profileName)
    const cloneFailure = await cloneProfile(profileDir, clonedProfile)
    if (cloneFailure !== null) {
      failures.push(cloneFailure)
    } else {
      const run = await runWebInClone(tmpHome, profileName, timeoutMs)
      ok = run.ok
      failedEntries = run.failedEntries
      failures.push(...run.failures)
    }
  } catch (error) {
    failures.push({ kind: 'boot', message: '冒烟准备失败：' + messageOf(error) })
  } finally {
    if (tmpHome !== null) {
      try {
        await rm(tmpHome, { recursive: true, force: true })
      } catch (error) {
        failures.push({
          kind: 'boot',
          message: '临时目录 ' + tmpHome + ' 清理失败：' + messageOf(error),
        })
      }
    }
  }

  return { ok, failures, failedEntries, durationMs: Date.now() - startedAt }
}
