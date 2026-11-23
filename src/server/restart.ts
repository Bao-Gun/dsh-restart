/**
 * 重启 helper 的宿主侧逻辑。
 *
 * 为什么重启要绕一层独立进程：dsh-daemon restart 会先 SIGTERM 当前 web 进程，
 * 而 daemon 被暂停（dsh-daemon stop -> ~/.dsh/daemon/.daemon-stopped）或没装时
 * daemon 命令直接返回 1。无论哪种情况，发起重启的 web 进程都等不到结果，
 * 所以路由回 202 之后由 scheduleRestart 派生一个脱离的 helper 进程，
 * 由 helper 推进「down -> up」并写日志。
 */
import { spawn as spawnProcess, type ChildProcess } from 'node:child_process'
import {
  accessSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

/** dsh web 的 /health 路径；daemon 与冒烟测试也用这个口径（200 才算活）。 */
const HEALTH_PATH = '/health'
/**
 * 本插件的就绪路由（Task 6 提供）。/health 只能证明 web 核心起来了，证明不了
 * 插件已加载——用错 DSH_HOME 的自拉起进程同样 200 /health，但侧栏里没有按钮。
 */
export const PLUGIN_STATUS_PATH = '/dsh-restart/api/status'
/** 探就绪路由时带的头，便于路由区分「helper 自检」与普通请求。 */
export const PLUGIN_STATUS_HEADER = 'x-dsh-restart'
/** web 回来之后给插件就绪的宽限（boot 期间该路由可能短暂 404）。 */
const PLUGIN_READY_GRACE_MS = 5_000
/** 轮询间隔。 */
const POLL_INTERVAL_MS = 250
/** 单次 /health 探测上限，防止一个卡住的连接把整轮等待拖死。 */
const PROBE_TIMEOUT_MS = 1_500
/** daemon 路径默认预算：daemon 自己的 STARTUP_GRACE_MS 低于这个值。 */
const DEFAULT_WAIT_MS = 60_000
/** 等锁持有者掉线/端口释放的预算（也受整体 waitMs 上界约束）。 */
const TAKEOVER_WAIT_MS = 10_000
/** 锁文件超过这个年龄一律视为残留（进程可能被 SIGKILL 掉，来不及清理）。 */
const STALE_LOCK_MS = 10 * 60_000
/** 锁文件名；路由/状态接口拼路径时用它，不要另写字面量。 */
export const RESTART_LOCK_NAME = 'restart.lock'
const LOG_FILE_PREFIX = 'helper-'

export type Probe = (port: number) => Promise<boolean>

export interface DaemonOutcome {
  code: number | null
  signal: string | null
  error?: string
}

export interface DaemonRestartHandle {
  /** 子进程结束；spawn 失败也通过 error 走到这里。 */
  exited: Promise<DaemonOutcome>
}

export interface StartWebOptions {
  /** helper 日志的 fd，子进程 stdout/stderr 直接继承。 */
  logFd: number
  /** profile 名，如 web；调用方显式传入时优先于 profileDir 的 basename。 */
  profileName: string
  port: number
  env: NodeJS.ProcessEnv
  /** dsh 可执行文件；优先于 DSH_RESTART_DSH_BIN 与 PATH 里的 dsh。 */
  dshBin?: string
}

export interface WebLaunchResult {
  pid?: number
  error?: string
}

export interface HelperDeps {
  /** 探活（只判 web 核心）；默认 GET http://127.0.0.1:<port>/health。 */
  probe?: Probe
  /** 探本插件是否已加载；默认 GET http://127.0.0.1:<port>/dsh-restart/api/status。 */
  probePlugin?: Probe
  /** 插件就绪宽限，默认 5s；集成测试里收窄。 */
  pluginGraceMs?: number
  /** 启动 dsh-daemon restart。 */
  startDaemonRestart?: (logFd: number) => DaemonRestartHandle
  /** 自拉起 dsh web。 */
  startWeb?: (options: StartWebOptions) => WebLaunchResult
  /** SIGTERM 旧 web。 */
  killWeb?: (pid: number) => void
  /** 以下三个用于虚拟时钟单测。 */
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  pollMs?: number
}

export interface RestartHelperOptions {
  port: number
  profileDir: string
  /** 日志与锁目录；默认 $DSH_RESTART_LOG_DIR 或 ~/.dsh/dsh-restart。 */
  logDir?: string
  /** 等一次完整重启的预算，默认 60s。 */
  waitMs?: number
  /** 必要时 SIGTERM 掉的旧 web 进程。 */
  webPid?: number
  /** dsh 的 home（内含 profiles/<name>）；已知就传，缺省才从 profileDir 反推。 */
  dshHome?: string
  /** profile 名；已知就传，缺省才从 profileDir 的 basename 反推。 */
  profileName?: string
  /** 自拉起用的 dsh 可执行文件；已知就传。 */
  dshBin?: string
  /** 等插件状态路由的宽限，默认 5s（在 waitMs 之外）。 */
  pluginGraceMs?: number
}

export interface ScheduleRestartOptions {
  port: number
  profileDir: string
  logDir: string
  /** 显式传 DSH_HOME，避免 helper 从 profileDir 反推错位置。 */
  dshHome?: string
  /** 显式传 profile 名，避免 helper 用 basename(profileDir) 猜错。 */
  profileName?: string
  /** 自拉起用的 dsh 可执行文件。 */
  dshBin?: string
}

export interface SpawnHelperChild {
  unref: () => void
  /** 真实子进程有；测试替身可以没有。 */
  on?: (event: 'error', listener: (error: Error) => void) => void
}

export type SpawnHelper = (
  command: string,
  args: string[],
  options: { detached: boolean; stdio: 'ignore'; env: NodeJS.ProcessEnv; cwd: string },
) => SpawnHelperChild

export interface ScheduleRestartDeps {
  helperPath?: string
  env?: NodeJS.ProcessEnv
  spawn?: SpawnHelper
}

interface PollClock {
  now: () => number
  sleep: (ms: number) => Promise<void>
  pollMs: number
}

/**
 * 选「首选路线」：daemon 已安装且没被 dsh-daemon stop 暂停时交给 daemon，
 * 否则由 helper 自拉起。
 *
 * 注意：无论返回哪个值，实际执行都从独立 helper 进程发起——daemon 路径会先
 * 掐掉当前 web；本函数只表达首选路线，供路由/界面展示。
 */
export function pickRoute(daemonInstalled: boolean, paused: boolean): 'daemon' | 'helper' {
  return daemonInstalled && !paused ? 'daemon' : 'helper'
}

/**
 * 重启是否被锁挡住。只做存在性检查：锁是否过期、持有者是否还活着，
 * 由 helper 在 acquireLock 里判断（避免状态接口替 helper 清理锁）。
 */
export async function isRefused(lockPath: string): Promise<boolean> {
  try {
    await access(lockPath)
    return true
  } catch {
    return false
  }
}

/** 默认探活：/health 返回 200 才算 web 可用。 */
async function probeHealth(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${HEALTH_PATH}`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: { accept: 'text/plain' },
    })
    try {
      await response.body?.cancel()
    } catch {
      // 丢弃 body 失败不影响判定。
    }
    return response.status === 200
  } catch {
    return false
  }
}

/**
 * 默认插件就绪探测：GET /dsh-restart/api/status 返回 200 才算插件已加载。
 *
 * /health 只覆盖 web 核心；用错 profile/DSH_HOME 的进程同样 200 /health，
 * 但侧栏里没有按钮——那种情况必须报「插件未加载」，不能报「已重启」。
 */
async function probePluginStatus(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${PLUGIN_STATUS_PATH}`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: { accept: 'application/json', [PLUGIN_STATUS_HEADER]: '1' },
    })
    try {
      await response.body?.cancel()
    } catch {
      // 丢弃 body 失败不影响判定。
    }
    return response.status === 200
  } catch {
    return false
  }
}

async function pollOnce(port: number, probe: Probe): Promise<boolean> {
  try {
    return await probe(port)
  } catch {
    return false
  }
}

/** 轮询直到 probe === wantUp 或超时；先立刻探一次。 */
async function pollState(
  port: number,
  timeoutMs: number,
  wantUp: boolean,
  probe: Probe,
  clock: PollClock,
): Promise<boolean> {
  const deadline = clock.now() + Math.max(0, timeoutMs)
  for (let spins = 0; spins < 100_000; spins += 1) {
    if ((await pollOnce(port, probe)) === wantUp) return true
    const remaining = deadline - clock.now()
    if (remaining <= 0) return false
    await clock.sleep(Math.min(clock.pollMs, remaining))
  }
  return false
}

/**
 * 等端口「活」：/health 200 才算。立即探一次，之后每 250ms 一次。
 * 超时返回 false；最后一次探测可能略超过 timeoutMs。
 */
export function waitForPort(port: number, timeoutMs: number, probe: Probe = probeHealth): Promise<boolean> {
  return pollState(port, timeoutMs, true, probe, { now: Date.now, sleep: delay, pollMs: POLL_INTERVAL_MS })
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 20261123T122328Z 形式的紧凑时间戳，用作日志文件名。 */
function compactTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

interface HelperLog {
  file: string
  fd: number
  write: (message: string) => void
  close: () => void
}

/**
 * 打开 helper 日志。daemon/web 子进程直接继承这个 fd，输出和 helper 自己的行
 * 交织在同一个文件里。建不出来时返回 null，由调用方退回 stderr。
 */
function openHelperLog(logDir: string, at: Date): HelperLog | null {
  try {
    mkdirSync(logDir, { recursive: true })
    const file = join(logDir, `${LOG_FILE_PREFIX}${compactTimestamp(at)}.log`)
    const fd = openSync(file, 'a', 0o600)
    let closed = false
    return {
      file,
      fd,
      write: (message) => {
        if (closed) return
        try {
          writeSync(fd, `${new Date().toISOString()} [pid ${process.pid}] ${message}\n`)
        } catch {
          // 日志写失败不影响重启本身。
        }
      },
      close: () => {
        if (closed) return
        closed = true
        try {
          closeSync(fd)
        } catch {
          // 已关闭。
        }
      },
    }
  } catch (error) {
    process.stderr.write(`[dsh-restart] 无法创建 helper 日志（${logDir}）：${messageOf(error)}\n`)
    return null
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM 说明进程存在，只是不归我们管。
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

interface LockSnapshot {
  pid: number | null
  ageMs: number
}

function readLock(lockPath: string): LockSnapshot | null {
  try {
    const raw = readFileSync(lockPath, 'utf8')
    const ageMs = Date.now() - statSync(lockPath).mtimeMs
    let pid: number | null = null
    try {
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed === 'object' && parsed !== null && typeof (parsed as { pid?: unknown }).pid === 'number') {
        pid = (parsed as { pid: number }).pid
      }
    } catch {
      // 内容写了一半也算不出来，交给年龄判断。
    }
    return { pid, ageMs }
  } catch {
    return null
  }
}

function lockIsStale(lockPath: string): boolean {
  const lock = readLock(lockPath)
  if (lock === null) return true
  if (lock.ageMs > STALE_LOCK_MS) return true
  if (lock.pid === null) return lock.ageMs > 10_000
  return !isAlive(lock.pid)
}

/**
 * 拿锁（logDir/restart.lock，O_EXCL）。EEXIST 时只在判定为残留后清理一次再重试；
 * 否则视为另一个 helper 正在重启。
 */
function acquireLock(lockPath: string, write: (message: string) => void): boolean {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockPath, 'wx', 0o600)
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))
      } finally {
        closeSync(fd)
      }
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        write(`无法创建锁文件 ${lockPath}：${messageOf(error)}`)
        return false
      }
      if (attempt === 0 && lockIsStale(lockPath)) {
        write(`清理残留锁文件 ${lockPath}`)
        try {
          unlinkSync(lockPath)
        } catch {
          // 别的进程可能已经清掉了。
        }
        continue
      }
      return false
    }
  }
  return false
}

function defaultStartDaemonRestart(logFd: number): DaemonRestartHandle {
  const command = process.env.DSH_RESTART_DAEMON_BIN?.trim() || 'dsh-daemon'
  let child: ChildProcess
  try {
    child = spawnProcess(command, ['restart'], { stdio: ['ignore', logFd, logFd], env: process.env })
  } catch (error) {
    return { exited: Promise.resolve({ code: null, signal: null, error: messageOf(error) }) }
  }
  const exited = new Promise<DaemonOutcome>((resolvePromise) => {
    child.once('error', (error) => {
      resolvePromise({ code: null, signal: null, error: messageOf(error) })
    })
    child.once('exit', (code, signal) => {
      resolvePromise({ code, signal })
    })
  })
  return { exited }
}

function defaultStartWeb(options: StartWebOptions): WebLaunchResult {
  const command = options.dshBin?.trim() || process.env.DSH_RESTART_DSH_BIN?.trim() || 'dsh'
  try {
    const child = spawnProcess(
      command,
      ['--profile', options.profileName, '--port', String(options.port), '--no-open'],
      {
        detached: true,
        stdio: ['ignore', options.logFd, options.logFd],
        env: options.env,
      },
    )
    child.once('error', (error) => {
      try {
        writeSync(
          options.logFd,
          `${new Date().toISOString()} [pid ${process.pid}] spawn dsh web 失败：${messageOf(error)}\n`,
        )
      } catch {
        // 日志 fd 已关。
      }
    })
    child.unref()
    return child.pid === undefined ? {} : { pid: child.pid }
  } catch (error) {
    return { error: messageOf(error) }
  }
}

function defaultKillWeb(pid: number): void {
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    // 已经退出。
  }
}

/**
 * 自拉起 dsh web 时的环境：关掉自动开浏览器，并指向正确的 DSH_HOME。
 * dshHome 显式传入时直接用；只有缺省才从 <DSH_HOME>/profiles/<name> 反推。
 */
function webEnv(dshHome: string | undefined, profileDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DSH_HOME: dshHome ?? dirname(dirname(profileDir)),
    DSH_DAEMON_OPEN_BROWSER: '0',
  }
}

/**
 * helper 主体：拿锁 -> dsh-daemon restart -> 观察「down -> up」；daemon 失败
 * （未安装、被暂停、15s 跳过、异常）时按需接管并自拉起 dsh web。
 * 返回 0 表示 web 最终健康，1 表示没有确认重启成功。
 */
export async function runRestartHelper(
  options: RestartHelperOptions,
  deps: HelperDeps = {},
): Promise<0 | 1> {
  const probe = deps.probe ?? probeHealth
  const pluginProbe = deps.probePlugin ?? probePluginStatus
  const pluginGraceMs = deps.pluginGraceMs ?? PLUGIN_READY_GRACE_MS
  const clock: PollClock = {
    now: deps.now ?? Date.now,
    sleep: deps.sleep ?? delay,
    pollMs: deps.pollMs ?? POLL_INTERVAL_MS,
  }
  const startedAt = clock.now()
  const port = options.port
  const profileDir = resolve(options.profileDir)
  // profile 名与 DSH_HOME 优先用调用方显式传入的值；只有缺参才从 profileDir 反推
  // （<DSH_HOME>/profiles/<name>），反推对非标准布局会静默指向错的 profile。
  const profileName = options.profileName ?? basename(profileDir)
  const dshHome = options.dshHome === undefined ? undefined : resolve(options.dshHome)
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS
  const logDir = resolve(
    options.logDir ?? (process.env.DSH_RESTART_LOG_DIR?.trim() || join(homedir(), '.dsh', 'dsh-restart')),
  )
  const startDaemonRestart = deps.startDaemonRestart ?? defaultStartDaemonRestart
  const startWeb = deps.startWeb ?? defaultStartWeb
  const killWeb = deps.killWeb ?? defaultKillWeb

  const log = openHelperLog(logDir, new Date(startedAt))
  const logFd = log?.fd ?? 2
  const write: (message: string) => void =
    log?.write ??
    ((message) => {
      process.stderr.write(`${new Date().toISOString()} ${message}\n`)
    })
  const lockPath = join(logDir, RESTART_LOCK_NAME)
  let locked = false

  /**
   * 成功判据第二段：/health 已经 200 之后，再确认本插件的状态路由也 200。
   * 两段分开写日志，失败时能看出是「web 没起来」还是「web 起来了但插件没加载」。
   */
  const confirmPlugin = async (label: string): Promise<boolean> => {
    const ready = await pollState(port, pluginGraceMs, true, pluginProbe, clock)
    if (ready) {
      write(`✅ web healthy on port ${port} after ${clock.now() - startedAt}ms（${label}，web + 插件均就绪）`)
      return true
    }
    write(
      `web 已起来但插件未加载（${PLUGIN_STATUS_PATH} 未在 ${pluginGraceMs}ms 内返回 200）；本次重启不算成功`,
    )
    return false
  }

  try {
    write(
      `restart helper start port=${port} profile=${profileDir} waitMs=${waitMs} log=${log?.file ?? '(stderr)'}`,
    )
    if (!acquireLock(lockPath, write)) {
      write(`refused: 锁 ${lockPath} 被占用，另一个 helper 正在重启`)
      return 1
    }
    locked = true
    write(`lock acquired ${lockPath} pid=${process.pid}`)

    const initialUp = await pollOnce(port, probe)
    write(`port before: ${initialUp ? 'up' : 'down'}`)

    const state: { outcome: DaemonOutcome | null } = { outcome: null }
    let handle: DaemonRestartHandle
    try {
      handle = startDaemonRestart(logFd)
    } catch (error) {
      handle = { exited: Promise.resolve({ code: null, signal: null, error: messageOf(error) }) }
    }
    void handle.exited.then(
      (value) => {
        state.outcome = value
      },
      (error) => {
        state.outcome = { code: null, signal: null, error: messageOf(error) }
      },
    )
    const outcomeNow = (): DaemonOutcome | null => state.outcome

    const deadline = clock.now() + waitMs
    /** 整体预算（m4）：takeover 与自拉起都用剩余额度，总时长 ≈ waitMs + 插件宽限。 */
    const remaining = (): number => Math.max(0, deadline - clock.now())
    let lastUp = initialUp
    let sawDown = !initialUp
    let healthy = false
    let skipped = false
    let failure: string | null = null
    let loggedOutcome = false

    for (let spins = 0; spins < 100_000; spins += 1) {
      const up = await pollOnce(port, probe)
      if (up !== lastUp) write(`port: ${up ? 'up' : 'down'} (+${clock.now() - startedAt}ms)`)
      if (!up) sawDown = true
      if (up && sawDown) {
        healthy = true
        break
      }
      lastUp = up

      const finished = outcomeNow()
      if (finished !== null && !loggedOutcome) {
        loggedOutcome = true
        write(
          `dsh-daemon restart ${
            finished.error !== undefined
              ? `启动失败：${finished.error}`
              : `退出 code=${String(finished.code)} signal=${finished.signal ?? 'null'}`
          }`,
        )
        if (finished.error !== undefined) failure = `无法启动 dsh-daemon restart：${finished.error}`
        else if (finished.code !== 0) failure = `dsh-daemon restart 退出码 ${String(finished.code)}`
        else if (up && !sawDown) {
          skipped = true
          break
        }
      }
      if (failure !== null) break
      if (clock.now() >= deadline) break
      await clock.sleep(clock.pollMs)
    }

    if (healthy) {
      return (await confirmPlugin('daemon 路径')) ? 0 : 1
    }

    const finished = outcomeNow()
    if (skipped) {
      write('daemon 跳过了重启（dsh web 刚启动不到 15s），本次不重启')
      return 1
    }
    if (finished === null) write(`dsh-daemon restart 未在 ${waitMs}ms 内退出`)
    else if (failure !== null) write(`daemon 路径失败：${failure}`)

    const nowUp = await pollOnce(port, probe)

    if (nowUp && !sawDown && finished?.code === 0) {
      // daemon 说健康、我们一次 down 都没看到：大概率是 15s 跳过，别重复拉起。
      write('daemon 报成功但未观察到端口下掉；按跳过处理，不自拉起')
      return 1
    }

    if (nowUp && failure === null) {
      // m5：把「daemon 卡住」和「daemon 报成功但我们没探到」分开写，别看混。
      write(
        finished === null
          ? `dsh-daemon restart 仍在运行（未在 ${waitMs}ms 内退出），且 /health 一直为 200；不自拉起`
          : 'daemon 报成功但 /health 在预算内未探到；不自拉起（避免和 daemon 抢端口）',
      )
      return 1
    }

    if (nowUp) {
      if (options.webPid === undefined || !isAlive(options.webPid)) {
        write(`接管失败：/health 仍为 200，但没有存活的 web PID（${String(options.webPid)}）可用`)
        return 1
      }
      write(`接管：SIGTERM 旧 web pid=${options.webPid}`)
      killWeb(options.webPid)
      const takeoverBudget = Math.min(TAKEOVER_WAIT_MS, remaining())
      const down = await pollState(port, takeoverBudget, false, probe, clock)
      if (!down) {
        write(`SIGTERM 后 ${takeoverBudget}ms 内 /health 仍为 200，放弃自拉起`)
        return 1
      }
      write('旧 web 已退出，开始自拉起')
    }

    write(`自拉起：dsh --profile ${profileName} --port ${port} --no-open`)
    const launchOptions: StartWebOptions = {
      logFd,
      profileName,
      port,
      env: webEnv(dshHome, profileDir),
    }
    if (options.dshBin !== undefined) launchOptions.dshBin = options.dshBin
    const launch = startWeb(launchOptions)
    if (launch.error !== undefined) {
      write(`自拉起失败：${launch.error}`)
      return 1
    }
    write(`自拉起进程已派生${launch.pid === undefined ? '（无 pid）' : ` pid=${launch.pid}`}`)

    const selfStartBudget = remaining()
    const back = await pollState(port, selfStartBudget, true, probe, clock)
    if (back) {
      return (await confirmPlugin('自拉起')) ? 0 : 1
    }
    write(`❌ 自拉起后 ${selfStartBudget}ms 内 /health 未返回 200`)
    return 1
  } finally {
    if (locked) {
      try {
        unlinkSync(lockPath)
      } catch {
        // 已被清理。
      }
    }
    log?.close()
  }
}

/**
 * 从当前（即将被 daemon 掐掉的）进程里派生 helper。只做一次 detached spawn：
 * helper 与当前进程脱钩，当前进程死了它继续跑；路由已经回过 202，这里出错也不外抛。
 *
 * 调用方必须保证响应已经 flush（Task 6：在 res.end() 之后的 'finish' 事件里调用）：
 * helper 起步就可能 SIGTERM 掉本进程，还没写出去的响应会一起丢。
 */
export function scheduleRestart(options: ScheduleRestartOptions, deps: ScheduleRestartDeps = {}): void {
  try {
    const helperPath = deps.helperPath ?? fileURLToPath(new URL('./helper.js', import.meta.url))
    const env: NodeJS.ProcessEnv = {
      ...(deps.env ?? process.env),
      DSH_RESTART_PORT: String(options.port),
      DSH_RESTART_PROFILE: resolve(options.profileDir),
      DSH_RESTART_LOG_DIR: resolve(options.logDir),
      DSH_RESTART_WEB_PID: String(process.pid),
    }
    // 显式入参优先：helper 不再靠路径反推 profile 位置。
    if (options.dshHome !== undefined) env.DSH_RESTART_DSH_HOME = resolve(options.dshHome)
    if (options.profileName !== undefined) env.DSH_RESTART_PROFILE_NAME = options.profileName
    if (options.dshBin !== undefined) env.DSH_RESTART_DSH_BIN = options.dshBin

    const spawnHelper = deps.spawn
    if (spawnHelper === undefined) {
      // 真实路径先验存在：stdio: 'ignore' 下 spawn 的异步 ENOENT 没人看得见。
      accessSync(helperPath)
    }
    const child = (spawnHelper ?? spawnProcess)(process.execPath, [helperPath], {
      detached: true,
      stdio: 'ignore',
      env,
      // 换个 cwd，避免当前目录被删/不可读时影响 helper 起步。
      cwd: homedir(),
    })
    child.on?.('error', (error) => {
      console.error(`[dsh-restart] 重启 helper 启动失败：${messageOf(error)}`)
    })
    child.unref()
  } catch (error) {
    console.error(`[dsh-restart] 无法启动重启 helper：${messageOf(error)}`)
  }
}
