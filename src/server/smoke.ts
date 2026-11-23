import { execFile, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

import type { Failure } from '../shared/types'

/**
 * 预检 C：克隆当前 profile 到临时 DSH_HOME，另起一个 dsh web，等 /health，收未激活名单。
 *
 * 三个安全点：
 * - 克隆必须用 APFS clonefile（cp -c）。硬链接会共享 inode，试跑写日志/auth 会写进线上 profile。
 * - 无论成功失败，finally 里都要杀掉整个进程组并删掉临时目录，不能留孤儿进程。
 * - 组长（dsh 主进程）可能比同组 sidecar 先退出，所以组清理以「组里还有没有成员」为准，
 *   不能以直接子进程退没退出来短路。
 */

const execFileAsync = promisify(execFile)

/** 轮询窗口 12s；总墙钟约 13s：克隆约 5s + 启动约 5s + SIGTERM 宽限 2s + 删两万多个文件。 */
const DEFAULT_SMOKE_TIMEOUT_MS = 12_000
const DUMP_CONFIG_TIMEOUT_MS = 20_000
const CLONE_TIMEOUT_MS = 60_000
const COPY_TIMEOUT_MS = 120_000
const HEALTH_POLL_INTERVAL_MS = 150
const KILL_GRACE_MS = 2_000
const KILL_KILL_GRACE_MS = 1_000
const GROUP_POLL_INTERVAL_MS = 50
/** 成功后再等输出静默一小段，避免漏掉 URL 之后才落盘的诊断行；上限 1s。 */
const OUTPUT_QUIET_MS = 200
const OUTPUT_SETTLE_CAP_MS = 1_000
/** 组长先退出时，给 close 事件留的冲刷时间；sidecar 占着管道也不会无限等。 */
const EXIT_FLUSH_MS = 200
/** 告警在启动早期，留开头；截断只防异常输出撑爆内存。 */
const STDERR_LIMIT = 256 * 1024
const STDOUT_LIMIT = 64 * 1024
const MAX_BUFFER = 8 * 1024 * 1024
const HEALTH_PROBE_TIMEOUT_MS = 1_500
/** 只认 web 自己那行 URL；devtools 的 ws=127.0.0.1:9231 不能被当成监听端口。 */
const WEB_URL_LINE = /dsh web:\s+(https?:\/\/[^\s]+)/

const ACTIVATION_MARKER = 'did not activate'
const OPTIONAL_HEADER = /entries did not activate/
/** 可选条目告警：<entry id> (<package>): <detail> */
const DIAGNOSTIC_LINE = /^(\S+) \(([^()]*)\): /
/** 必需条目失败块：两空格缩进的 id，下一行才是 Package。 */
const STARTUP_FAILED_LINE = /^ {2}(\S+?)(?: \(required\))?$/
const STARTUP_PACKAGE_LINE = /^ {4}Package: /

const SMOKE_DIR_PREFIX = 'dsh-smoke-'
const RUN_PID_FILE = 'run.pid'
/** 试跑实例的 pid + 身份（lstart/command）；清扫前必须比对，防止 pid 复用误杀。 */
const DSH_IDENTITY_FILE = 'dsh.json'
/** 比一次冒烟（总墙钟约 15s）更保守；更年轻的目录可能正被并发冒烟使用。 */
const STALE_DIR_MIN_AGE_MS = 30_000

export interface SmokeOptions {
  profileDir: string
  /** 调用方给的临时根目录；冒烟只在自己建的子目录里折腾，不删 tmpRoot 本身。 */
  tmpRoot: string
  timeoutMs?: number
}

export interface SmokeResult {
  /**
   * health && 进程组确认清空 && 临时目录删干净。
   * 调用方还必须要求 failures 为空、diffFailedEntries(本次, 基线) 的 added 为空。
   */
  ok: boolean
  /** 单独保留 /health 是否 200，供展示用；不包含清理结果。 */
  health: boolean
  /** 启动失败、克隆失败、清理失败这类硬失败；未激活名单不算失败。 */
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

interface WebUrlProbe {
  port: number | null
  /** 打印了 dsh web: URL 但取不到本地监听端口（如 public-url 形态）。 */
  urlWithoutPort: string | null
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

/** 快检 A 与冒烟共用同一个二进制入口，避免一套 PATH 下快检 A 失败、冒烟却正常。 */
function resolveDshBin(): string {
  return process.env.DSH_RESTART_DSH_BIN ?? 'dsh'
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

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

interface ProcessIdentity {
  lstart: string
  command: string
}

/** 只认命令行里真的出现 dsh；配合 lstart 与整条 command 比对，防 pid 复用误杀。 */
function isDshCommand(command: string): boolean {
  return /\bdsh\b/.test(command)
}

/** ps 的 lstart 与完整 command；取不到就返回 null，调用方按「无法确认」处理。 */
async function probeProcessIdentity(pid: number): Promise<ProcessIdentity | null> {
  if (process.platform === 'win32') return null
  try {
    const { stdout } = await execFileAsync(
      'ps',
      ['-p', String(pid), '-o', 'lstart=', '-o', 'command='],
      { timeout: 2_000, maxBuffer: 64 * 1024, encoding: 'utf8' },
    )
    const line = stdout.trim()
    const match = /^(\S{3}\s+\S{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/.exec(line)
    if (match === null) return null
    const lstart = match[1] ?? ''
    const command = (match[2] ?? '').trim()
    if (lstart === '' || command === '') return null
    return { lstart, command }
  } catch {
    return null
  }
}

/** spawn 后落盘身份；写失败只会让后续陈旧清扫更保守（不发信号），不影响本次冒烟。 */
async function recordDshIdentity(dir: string, pid: number): Promise<void> {
  const identity = await probeProcessIdentity(pid)
  if (identity === null || !isDshCommand(identity.command)) return
  try {
    await writeFile(
      join(dir, DSH_IDENTITY_FILE),
      JSON.stringify({ pid, lstart: identity.lstart, command: identity.command }),
      'utf8',
    )
  } catch {
    // 目录可能已被 finally 删掉，忽略
  }
}

async function readDshIdentity(
  dir: string,
): Promise<{ pid: number; lstart: string; command: string } | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(dir, DSH_IDENTITY_FILE), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as Record<string, unknown>
    const pid = record['pid']
    const lstart = record['lstart']
    const command = record['command']
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null
    if (typeof lstart !== 'string' || lstart === '') return null
    if (typeof command !== 'string' || command === '') return null
    return { pid, lstart, command }
  } catch {
    return null
  }
}

/** run.pid 必须同步落盘：mkdtemp 与写文件之间不能有 await，否则并发清扫会删到在飞目录。 */
function writeRunPidFile(dir: string): void {
  writeFileSync(join(dir, RUN_PID_FILE), String(process.pid), 'utf8')
}

function groupAlive(pid: number): boolean {
  if (process.platform === 'win32') return false
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function waitForGroupGone(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!groupAlive(pid)) return true
    await delay(GROUP_POLL_INTERVAL_MS)
  }
  return !groupAlive(pid)
}

/**
 * 按进程组清理：先 SIGTERM，轮询到组空；还在就 SIGKILL。
 * 组长已经退出但组员还活着时，kill(-pid) 依然有效，所以不能看 child.exitCode 短路。
 */
async function terminateGroup(pid: number, graceMs: number, killGraceMs: number): Promise<boolean> {
  if (!groupAlive(pid)) return true
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    return !groupAlive(pid)
  }
  if (await waitForGroupGone(pid, graceMs)) return true
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    // 组在 SIGTERM 宽限的最后一刻空了
  }
  return waitForGroupGone(pid, killGraceMs)
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

/**
 * 杀整个进程组。pid 都拿不到（spawn 直接失败）才短路；其余一律按组探活。
 * Windows 没有负 pid 进程组，只能退化为终止直接子进程。
 */
export async function killProcessTree(child: ChildProcess): Promise<boolean> {
  const pid = child.pid
  if (pid === undefined) return true

  if (process.platform === 'win32') {
    if (child.exitCode !== null || child.signalCode !== null) return true
    const exited = waitForExit(child, KILL_GRACE_MS)
    try {
      child.kill('SIGTERM')
    } catch {
      // 已退出
    }
    if (await exited) return true
    const killed = waitForExit(child, KILL_KILL_GRACE_MS)
    try {
      child.kill('SIGKILL')
    } catch {
      // 已退出
    }
    return killed
  }

  return terminateGroup(pid, KILL_GRACE_MS, KILL_KILL_GRACE_MS)
}

async function readPidFile(dir: string, name: string): Promise<number | null> {
  try {
    const raw = await readFile(join(dir, name), 'utf8')
    const pid = Number.parseInt(raw.trim(), 10)
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

/**
 * 上一次冒烟如果被外部重启/强杀打断，finally 不会执行，会留下 dsh-smoke-* 目录和 detached 试跑实例。
 * 每次冒烟前先收一遍，顺序是：
 * 1. 目录 mtime 太新（< 30s）→ 可能正在飞，跳过；
 * 2. run.pid 对应的冒烟进程还活着 → 并发冒烟，跳过；
 * 3. dsh.json 记录了 pid + lstart + command，三项与当前 ps 完全对上才发信号；
 *    任何一项取不到或对不上 → 只删目录，绝不碰进程组（防 pid 复用误杀陌生进程）。
 */
export async function cleanupStaleSmokeDirs(
  tmpRoot: string,
): Promise<{ removed: string[]; failures: Failure[] }> {
  const removed: string[] = []
  const failures: Failure[] = []
  let entries
  try {
    entries = await readdir(tmpRoot, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { removed, failures }
    throw error
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(SMOKE_DIR_PREFIX)) continue
    const dir = join(tmpRoot, entry.name)

    let ageMs: number
    try {
      ageMs = Date.now() - (await stat(dir)).mtimeMs
    } catch {
      continue
    }
    if (ageMs < STALE_DIR_MIN_AGE_MS) continue

    const ownerPid = await readPidFile(dir, RUN_PID_FILE)
    if (ownerPid !== null && processAlive(ownerPid)) continue

    const identity = await readDshIdentity(dir)
    if (identity !== null) {
      const current = await probeProcessIdentity(identity.pid)
      const confirmed =
        current !== null &&
        current.lstart === identity.lstart &&
        current.command === identity.command &&
        isDshCommand(current.command)
      if (confirmed) {
        const cleaned = await terminateGroup(identity.pid, KILL_GRACE_MS, KILL_KILL_GRACE_MS)
        if (!cleaned) {
          failures.push({
            kind: 'boot',
            message:
              '陈旧冒烟目录 ' +
              dir +
              ' 的进程组 ' +
              String(identity.pid) +
              ' 杀不掉，保留目录待人工处理',
          })
          continue
        }
      }
    }

    try {
      await rm(dir, { recursive: true, force: true })
      removed.push(entry.name)
    } catch (error) {
      failures.push({
        kind: 'boot',
        message: '清理陈旧冒烟目录 ' + dir + ' 失败：' + messageOf(error),
      })
    }
  }

  return { removed, failures }
}

/**
 * 从 stderr 里抽「本次没激活」的条目 id 名单。
 *
 * 宿主有两种格式：
 * - 可选条目：'dsh web: warning: N entries did not activate' 后紧跟 'id (pkg): detail' 若干行；
 * - 必需条目：'dsh web: startup failed: ...' 下的 'Failed plugins' 块，id 单独一行、下一行是 'Package:'。
 * 没有 did not activate 标记时一律返回空，避免把别的告警误当未激活名单。
 * 可选条目只扫描紧跟告警头的一段连续诊断行，避免同屏无关的 'x (y): z' 污染基线。
 * 宿主的 pending 表格（Plugins waiting for services）不解析；走到那条路径时 /health 通常不会 200，
 * 由失败分类兜底，不会把 pending 条目静默当成已激活。
 */
export function parseNotActivated(stderr: string): string[] {
  const lines = stderr.split(/\r?\n/)
  if (!lines.some((line) => line.includes(ACTIVATION_MARKER))) return []

  const entries: string[] = []
  const seen = new Set<string>()
  const push = (id: string): void => {
    if (id === '' || seen.has(id)) return
    seen.add(id)
    entries.push(id)
  }

  for (let index = 0; index < lines.length; index += 1) {
    if (!OPTIONAL_HEADER.test(lines[index] ?? '')) continue
    let cursor = index + 1
    while (cursor < lines.length) {
      const match = DIAGNOSTIC_LINE.exec(lines[cursor] ?? '')
      if (match === null) break
      push(match[1] ?? '')
      cursor += 1
    }
  }

  for (let index = 0; index < lines.length; index += 1) {
    const failed = STARTUP_FAILED_LINE.exec(lines[index] ?? '')
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
  const bin = resolveDshBin()

  const outcome = await runCommand(bin, ['--profile', profileName, '--dump-config'], {
    env: { ...process.env, DSH_HOME: home },
    timeoutMs: DUMP_CONFIG_TIMEOUT_MS,
  })

  if (outcome.spawnError !== null) {
    return [
      {
        kind: 'config',
        message: '无法启动 ' + bin + ' --dump-config：' + outcome.spawnError,
      },
    ]
  }
  if (outcome.timedOut) {
    return [
      {
        kind: 'config',
        message:
          bin +
          ' --profile ' +
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
        message: bin + ' --profile ' + profileName + ' --dump-config 失败（' + describeCommand(outcome) + '）',
      },
    ]
  }

  // dump-config 不激活条目，正常情况下这个分支不会触发；保留以覆盖宿主未来在
  // 合成阶段也输出 activation 诊断的异常，避免静默放过。
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

function parseWebUrl(stdout: string): WebUrlProbe {
  const line = WEB_URL_LINE.exec(stdout)
  if (line === null) return { port: null, urlWithoutPort: null }

  const raw = line[1] ?? ''
  try {
    const url = new URL(raw)
    const port = Number(url.port)
    if (Number.isInteger(port) && port > 0) return { port, urlWithoutPort: null }
    return { port: null, urlWithoutPort: raw }
  } catch {
    return { port: null, urlWithoutPort: raw }
  }
}

/** 等到输出安静 OUTPUT_QUIET_MS，或到上限；避免固定 100ms 掩盖写者顺序。 */
async function settleOutput(lastOutputAt: () => number): Promise<void> {
  const cap = Date.now() + OUTPUT_SETTLE_CAP_MS
  while (Date.now() < cap) {
    if (Date.now() - lastOutputAt() >= OUTPUT_QUIET_MS) return
    await delay(25)
  }
}

/** 起试跑实例、等 /health；无论结果如何都在 finally 里结束进程组。 */
async function runWebInClone(
  tmpHome: string,
  profileName: string,
  timeoutMs: number,
): Promise<{ health: boolean; cleaned: boolean; failures: Failure[]; failedEntries: string[] }> {
  const bin = resolveDshBin()
  const homeNote = '（试跑 DSH_HOME: ' + tmpHome + '，仅克隆 profile 层）'
  const child = spawn(bin, ['--profile', profileName, '--port', '0', '--no-open'], {
    env: { ...process.env, DSH_HOME: tmpHome, DSH_DAEMON_OPEN_BROWSER: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  })

  let stdout = ''
  let stderr = ''
  let lastOutputAt = Date.now()
  // 数组而不是 let：TS 不追踪回调里的赋值，用 let 会在检查处被收窄成 null
  const spawnErrors: string[] = []
  const exitRecords: Array<{ code: number | null; signal: string | null }> = []
  let port: number | null = null
  let urlWithoutPort: string | null = null
  let healthStatus: number | null = null
  let lastProbeError = ''
  let health = false
  let cleaned = true

  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    stdout = appendCapped(stdout, chunk, STDOUT_LIMIT)
    lastOutputAt = Date.now()
  })
  child.stderr?.on('data', (chunk: string) => {
    stderr = appendCapped(stderr, chunk, STDERR_LIMIT)
    lastOutputAt = Date.now()
  })
  child.once('error', (error) => {
    spawnErrors.push(messageOf(error))
  })
  // exit 用于「提前退出」判定；close 只用于给管道冲刷留一个上限，sidecar 占着管道也不会无限等
  child.once('exit', (code, signal) => {
    exitRecords.push({ code, signal })
  })
  const streamClosed = new Promise<void>((resolveClosed) => {
    child.once('close', () => resolveClosed())
  })
  if (child.pid !== undefined) void recordDshIdentity(tmpHome, child.pid)

  const failures: Failure[] = []
  const deadline = Date.now() + timeoutMs
  try {
    while (Date.now() < deadline) {
      if (spawnErrors.length > 0 || exitRecords.length > 0) break
      const probe = parseWebUrl(stdout)
      if (probe.port !== null) port = probe.port
      if (probe.urlWithoutPort !== null) urlWithoutPort = probe.urlWithoutPort
      if (port !== null) {
        try {
          const response = await fetch('http://127.0.0.1:' + String(port) + '/health', {
            signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
          })
          healthStatus = response.status
          if (response.status === 200) {
            health = true
            break
          }
        } catch (error) {
          lastProbeError = messageOf(error)
        }
      }
      await delay(HEALTH_POLL_INTERVAL_MS)
    }

    if (health) {
      // 告警通常写在 URL 之前，但 stdout/stderr 是两个写者；等输出静默再取名单
      await settleOutput(() => lastOutputAt)
    } else if (exitRecords.length > 0) {
      // 组长先退出时 close 可能被 sidecar 拖住；只等一小段，避免把「提前退出」误报成超时
      await Promise.race([streamClosed, delay(EXIT_FLUSH_MS)])
    }

    if (health) {
      // health 只表示 /health 200；清理结果由 finally 写入 cleaned
    } else if (spawnErrors.length > 0) {
      failures.push({
        kind: 'boot',
        message: '无法启动试跑实例（' + bin + '）：' + (spawnErrors[0] ?? '') + homeNote,
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
        message:
          '试跑实例提前退出（' + status + '）' +
          (detail === '' ? '' : '：' + detail) +
          homeNote,
      })
    } else if (port === null && urlWithoutPort !== null) {
      failures.push({
        kind: 'boot',
        message:
          '试跑实例打印的 Web URL 取不到本地监听端口（可能是 public-url 形态）：' +
          urlWithoutPort +
          homeNote,
      })
    } else if (port === null) {
      const detail = tail(stderr)
      failures.push({
        kind: 'boot',
        message:
          '试跑实例在 ' +
          String(timeoutMs) +
          'ms 内没有打印 Web URL' +
          (detail === '' ? '' : '：' + detail) +
          homeNote,
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
          '）' +
          homeNote,
      })
    }

  } finally {
    cleaned = await killProcessTree(child)
    if (!cleaned) {
      failures.push({
        kind: 'boot',
        message:
          '试跑实例（pid ' + String(child.pid) + '）的进程组在 SIGKILL 后仍未退出，可能留下孤儿进程' +
          homeNote,
      })
    }
  }

  return { health, cleaned, failures, failedEntries: parseNotActivated(stderr) }
}

/**
 * 配置合成已在别处做过（runDumpConfig）；这里只负责「换个 DSH_HOME 真启动一次」。
 * ok = health && 进程组清空 && 临时目录删干净；调用方还必须要求 failures 为空、added 为空。
 *
 * 只克隆 profile 层：home 级的 .env / settings.yaml / plugins / daemon 不参与，
 * 所以试跑看到的环境分层可能与线上不同（理论上会造成假红或假绿）。
 */
export async function runSmoke(options: SmokeOptions): Promise<SmokeResult> {
  const startedAt = Date.now()
  const profileDir = resolve(options.profileDir)
  const profileName = basename(profileDir)
  const timeoutMs = options.timeoutMs ?? DEFAULT_SMOKE_TIMEOUT_MS
  const failures: Failure[] = []
  let health = false
  let processesCleaned = true
  let dirCleaned = true
  let failedEntries: string[] = []
  let tmpHome: string | null = null

  try {
    const tmpRoot = resolve(options.tmpRoot)
    await mkdir(tmpRoot, { recursive: true })

    const stale = await cleanupStaleSmokeDirs(tmpRoot)
    failures.push(...stale.failures)

    tmpHome = await mkdtemp(join(tmpRoot, SMOKE_DIR_PREFIX))
    const home = tmpHome
    // 同步写：中间只要有 await，并发清扫就可能把刚 mkdtemp 的在飞目录当成孤儿删掉
    writeRunPidFile(home)
    await mkdir(join(home, 'profiles'), { recursive: true })

    const clonedProfile = join(home, 'profiles', profileName)
    const cloneFailure = await cloneProfile(profileDir, clonedProfile)
    if (cloneFailure !== null) {
      failures.push({
        ...cloneFailure,
        message: cloneFailure.message + '（试跑 DSH_HOME: ' + home + '，仅克隆 profile 层）',
      })
    } else {
      const run = await runWebInClone(home, profileName, timeoutMs)
      health = run.health
      processesCleaned = run.cleaned
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
        dirCleaned = false
        failures.push({
          kind: 'boot',
          message: '临时目录 ' + tmpHome + ' 清理失败：' + messageOf(error),
        })
      }
    }
  }

  const ok = health && processesCleaned && dirCleaned
  return { ok, health, failures, failedEntries, durationMs: Date.now() - startedAt }
}
