/**
 * helper 进程入口：由 scheduleRestart 以 detached 方式派生。
 *
 * 只做「读环境 -> 调 runRestartHelper -> exit code」；重启状态机都在
 * src/server/restart.ts。测试 import 本文件时不会自动执行（见文件末尾的入口判断）。
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { runRestartHelper, type HelperDeps } from '../server/restart'

export interface HelperConfig {
  port: number
  profileDir: string
  logDir: string
  waitMs?: number
  webPid?: number
  /** 显式传入时优先于从 profileDir 反推。 */
  dshHome?: string
  /** 显式传入时优先于 basename(profileDir)。 */
  profileName?: string
  dshBin?: string
  /** 插件状态路由的宽限，见 PLUGIN_READY_GRACE_MS。 */
  pluginGraceMs?: number
}

export type HelperConfigParse = { ok: true; config: HelperConfig } | { ok: false; error: string }

function parsePort(raw: string | undefined): number | null {
  const text = raw?.trim() ?? ''
  if (text === '') return null
  const value = Number(text)
  if (!Number.isInteger(value) || value < 1 || value > 65_535) return null
  return value
}

function parsePositiveInt(raw: string | undefined): number | null {
  const text = raw?.trim() ?? ''
  if (text === '') return null
  const value = Number(text)
  if (!Number.isInteger(value) || value <= 0) return null
  return value
}

/** 从 scheduleRestart 传下来的环境变量解析 helper 配置。 */
export function parseHelperConfig(env: Record<string, string | undefined>): HelperConfigParse {
  const rawPort = env.DSH_RESTART_PORT
  const port = parsePort(rawPort)
  if (port === null) {
    return { ok: false, error: `DSH_RESTART_PORT 不是合法端口：${JSON.stringify(rawPort ?? '')}` }
  }

  const profileDir = env.DSH_RESTART_PROFILE?.trim() ?? ''
  if (profileDir === '') {
    return { ok: false, error: 'DSH_RESTART_PROFILE 未设置' }
  }

  const config: HelperConfig = {
    port,
    profileDir,
    logDir: env.DSH_RESTART_LOG_DIR?.trim() || join(homedir(), '.dsh', 'dsh-restart'),
  }

  const rawWait = env.DSH_RESTART_WAIT_MS
  if (rawWait !== undefined && rawWait.trim() !== '') {
    const waitMs = parsePositiveInt(rawWait)
    if (waitMs === null) return { ok: false, error: `DSH_RESTART_WAIT_MS 不合法：${JSON.stringify(rawWait)}` }
    config.waitMs = waitMs
  }

  const dshHome = env.DSH_RESTART_DSH_HOME?.trim() ?? ''
  if (dshHome !== '') config.dshHome = dshHome

  const profileName = env.DSH_RESTART_PROFILE_NAME?.trim() ?? ''
  if (profileName !== '') config.profileName = profileName

  const dshBin = env.DSH_RESTART_DSH_BIN?.trim() ?? ''
  if (dshBin !== '') config.dshBin = dshBin

  const rawGrace = env.DSH_RESTART_PLUGIN_GRACE_MS
  if (rawGrace !== undefined && rawGrace.trim() !== '') {
    const pluginGraceMs = parsePositiveInt(rawGrace)
    if (pluginGraceMs === null) {
      return { ok: false, error: `DSH_RESTART_PLUGIN_GRACE_MS 不合法：${JSON.stringify(rawGrace)}` }
    }
    config.pluginGraceMs = pluginGraceMs
  }

  const rawPid = env.DSH_RESTART_WEB_PID
  if (rawPid !== undefined && rawPid.trim() !== '') {
    const webPid = parsePositiveInt(rawPid)
    if (webPid === null) return { ok: false, error: `DSH_RESTART_WEB_PID 不合法：${JSON.stringify(rawPid)}` }
    config.webPid = webPid
  }

  return { ok: true, config }
}

export interface HelperMainOptions {
  env?: Record<string, string | undefined>
  deps?: HelperDeps
  /** 默认写 process.stderr；测试可换成收集器。 */
  stderr?: (text: string) => void
}

/**
 * 配置错误时 stderr 大概率是 /dev/null（helper 以 stdio: 'ignore' 派生），
 * 所以再尽力往 <logDir>/helper-last-error.log 追加一行，方便事后查。
 */
function appendHelperErrorLog(env: Record<string, string | undefined>, message: string): void {
  try {
    const logDir = env.DSH_RESTART_LOG_DIR?.trim() || join(homedir(), '.dsh', 'dsh-restart')
    mkdirSync(logDir, { recursive: true })
    appendFileSync(
      join(logDir, 'helper-last-error.log'),
      `${new Date().toISOString()} [pid ${process.pid}] ${message}\n`,
    )
  } catch {
    // 连日志目录都建不出来时只能放弃，不能让 helper 因日志崩溃。
  }
}

/** helper 主流程；配置错误写 stderr + helper-last-error.log 并返回 1。 */
export async function helperMain(options: HelperMainOptions = {}): Promise<0 | 1> {
  const env = options.env ?? process.env
  const stderr =
    options.stderr ??
    ((text: string) => {
      process.stderr.write(text)
    })
  const parsed = parseHelperConfig(env)
  if (!parsed.ok) {
    appendHelperErrorLog(env, `配置错误：${parsed.error}`)
    stderr(`[dsh-restart] helper 配置错误：${parsed.error}\n`)
    return 1
  }
  return runRestartHelper(parsed.config, options.deps ?? {})
}

/** 只有被 node 直接执行（而不是被测试 import）时才跑。 */
function invokedDirectly(): boolean {
  const entry = process.argv[1]
  if (entry === undefined) return false
  try {
    return pathToFileURL(entry).href === import.meta.url
  } catch {
    return false
  }
}

if (invokedDirectly()) {
  void helperMain().then(
    (code) => {
      process.exit(code)
    },
    (error: unknown) => {
      const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
      process.stderr.write(`[dsh-restart] helper 崩溃：${detail}\n`)
      process.exit(1)
    },
  )
}
