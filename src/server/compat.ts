import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

import type { Failure } from '../shared/types'
import { parseRuntime } from '../shared/version'

/** 宿主包里的两个符号；签名照 0.2.2-rc.5 的 lib/types/plugin-compatibility.d.ts。 */
interface HostCompatibilityIssue {
  name: string
  version: string
  runtimeVersion: string
  /** 只有没满足的要求：'engines.dsh' 或具体的 dsh-* peer 包名 */
  requirements: Record<string, string>
  exempted: boolean
}

interface HostCompatibility {
  evaluatePluginCompatibility(
    manifest: object,
    exemptions?: Readonly<Record<string, readonly string[]>>,
    runtimeVersion?: string,
  ): HostCompatibilityIssue | undefined
  getDshRuntimeVersion(): string
}

/** 一个装进 profile 的插件。 */
export interface InstalledPlugin {
  /** profile 里的身份：依赖直接就是包名，只挂在 patch 里的用条目 id */
  id: string
  name: string
  version: string
  /** 插件自己声明的最低 dsh 版本；存在时宿主只认它 */
  enginesDsh?: string
  /** 没有 engines.dsh 时才看的 `@deepseek-ai/dsh` peer 范围 */
  peerDsh?: string
  /**
   * 完整的 dsh peer 集合。宿主的规则会逐个检查 `@deepseek-ai/dsh` 与
   * `@deepseek-ai/dsh-*`，只留 peerDsh 会让 dsh-tools 这类 peer 悄悄漏判。
   */
  peerDependencies?: Record<string, string>
}

export interface ReadInstalledOptions {
  /** 单个插件读不动时回调一条 warning；默认忽略（不抛）。 */
  onWarning?: (failure: Failure) => void
}

const DSH_PACKAGE = '@deepseek-ai/dsh'
const BOOT_PACKAGE = '@deepseek-ai/dsh-app-boot'
const BOOT_ENTRY = join('node_modules', '@deepseek-ai', 'dsh-app-boot')

/** 兜底：node 与全局 node_modules 通常同层（homebrew、usr/local 都是这个形状）。 */
const EXTRA_INSTALL_DIRS = [
  '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh',
  '/usr/local/lib/node_modules/@deepseek-ai/dsh',
]

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

function realpathOf(file: string): string {
  try {
    return realpathSync(file)
  } catch {
    return file
  }
}

/** 从入口往上找 dsh 安装目录；全局安装的入口是 bin 里的软链，所以先解真身。 */
function ancestorsOf(file: string): string[] {
  const dirs: string[] = []
  let dir = dirname(realpathOf(file))
  for (let depth = 0; depth < 12; depth += 1) {
    dirs.push(dir)
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return dirs
}

function isDshInstall(dir: string): boolean {
  const manifest = readJson(join(dir, 'package.json'))
  return isPlainObject(manifest) && manifest.name === DSH_PACKAGE
}

let hostModule: HostCompatibility | null | undefined
let hostProblem = ''

/**
 * 取宿主那份判定函数。
 *
 * 不能静态 import：插件装进 profile 后，`@deepseek-ai/*` 不在它自己的解析路径上
 * （官方包在 dsh 安装目录的 node_modules 里，profile 只放第三方插件）。也不能靠打包：
 * 打进来以后 getDshRuntimeVersion 会读本包的 package.json，版本变成 0.1.0，
 * 判定就静默失真了。所以运行时按入口定位 dsh 安装目录，再从它的依赖树里取。
 * 返回 null 表示定位/加载失败，调用方必须报失败而不是默认放行。
 */
export function hostCompatibility(): HostCompatibility | null {
  if (hostModule !== undefined) return hostModule
  hostModule = null

  const candidates: string[] = []
  const override = process.env.DSH_RESTART_BOOT_DIR
  if (override !== undefined && override !== '') candidates.push(override)

  const installDirs = [
    process.env.DSH_RESTART_DSH_DIR,
    ...ancestorsOf(process.argv[1] ?? ''),
    join(dirname(process.execPath), '..', 'lib', 'node_modules', DSH_PACKAGE),
    ...EXTRA_INSTALL_DIRS,
  ]
  for (const dir of installDirs) {
    if (typeof dir === 'string' && dir !== '' && isDshInstall(dir)) candidates.push(join(dir, BOOT_ENTRY))
  }

  for (const dir of candidates) {
    const manifest = readJson(join(dir, 'package.json'))
    if (!isPlainObject(manifest)) {
      hostProblem = `${dir} 里没有可读的 package.json`
      continue
    }
    const main = typeof manifest.main === 'string' && manifest.main !== '' ? manifest.main : 'lib/index.js'
    try {
      // dsh 自己要求 node >=24.9，require(ESM) 一定可用
      const loaded = createRequire(join(dir, 'package.json'))(join(dir, main)) as Partial<HostCompatibility>
      if (typeof loaded.evaluatePluginCompatibility !== 'function' || typeof loaded.getDshRuntimeVersion !== 'function') {
        hostProblem = `${BOOT_PACKAGE} 没有导出判定函数（${dir}）`
        continue
      }
      hostModule = loaded as HostCompatibility
      return hostModule
    } catch (error) {
      hostProblem = error instanceof Error ? error.message : String(error)
    }
  }
  return hostModule
}

/** 生产路径的运行时版本：从宿主 API 取；取不到返回空串，交给 compatFailures 报失败。 */
export function hostRuntimeVersion(): string {
  try {
    return hostCompatibility()?.getDshRuntimeVersion() ?? ''
  } catch {
    return ''
  }
}

function expectedOf(requirements: Record<string, string>): string {
  return Object.values(requirements).join(', ')
}

function judgeOne(host: HostCompatibility, plugin: InstalledPlugin, runtimeVersion: string): Failure | null {
  const manifest: Record<string, unknown> = { name: plugin.name, version: plugin.version }
  if (plugin.enginesDsh !== undefined) manifest.engines = { dsh: plugin.enginesDsh }
  if (plugin.peerDependencies !== undefined) {
    manifest.peerDependencies = plugin.peerDependencies
  } else if (plugin.peerDsh !== undefined) {
    manifest.peerDependencies = { [DSH_PACKAGE]: plugin.peerDsh }
  }

  try {
    const issue = host.evaluatePluginCompatibility(manifest, {}, runtimeVersion)
    if (issue === undefined || issue.exempted) return null

    const expected = expectedOf(issue.requirements)
    const name = issue.name !== '' ? issue.name : plugin.name !== '' ? plugin.name : plugin.id
    return {
      plugin: name,
      kind: 'compat',
      message: `插件 ${name}@${issue.version || plugin.version} 与 dsh ${runtimeVersion} 不兼容：要求 ${expected}`,
      expected,
      actual: runtimeVersion,
    }
  } catch (error) {
    // 清单坏掉只影响这一个插件，整轮快检继续
    return {
      plugin: plugin.name !== '' ? plugin.name : plugin.id,
      kind: 'compat',
      message: `插件 ${plugin.name || plugin.id} 的清单无法判定：${error instanceof Error ? error.message : String(error)}`,
      actual: runtimeVersion,
    }
  }
}

/**
 * 按宿主规则判每个插件的 dsh 要求，返回不满足的那些。
 *
 * 安全点：取不到运行时版本、或加载不到宿主判定函数时，必须返回一条明确 failure。
 * 静默判「兼容」= 预检永远通过，比不做预检更糟。
 */
export function compatFailures(plugins: InstalledPlugin[], runtimeVersion: string): Failure[] {
  // parseRuntime 对非法输入直接抛（与宿主 runtimeVersionOf 一致），这里转成明确 failure
  try {
    parseRuntime(runtimeVersion)
  } catch (error) {
    return [
      {
        kind: 'compat',
        message: `取不到合法的 dsh 运行时版本（${JSON.stringify(runtimeVersion)}）：${error instanceof Error ? error.message : String(error)}；无法判定插件兼容性，不能默认放行`,
        expected: '合法语义化版本',
        actual: runtimeVersion,
      },
    ]
  }

  const host = hostCompatibility()
  if (host === null) {
    return [
      {
        kind: 'compat',
        message: `加载不到宿主的兼容性判定（${hostProblem || BOOT_PACKAGE}），无法判定插件兼容性；不能默认放行`,
        actual: runtimeVersion,
      },
    ]
  }

  const failures: Failure[] = []
  for (const plugin of plugins) {
    const failure = judgeOne(host, plugin, runtimeVersion)
    if (failure !== null) failures.push(failure)
  }
  return failures
}

const DSH_PEER_PREFIX = `${DSH_PACKAGE}-`
const PATCH_ID = /^\s*-\s+id:\s*(\S+)\s*$/
const PATCH_NAME = /^\s+(?:-\s+)?name:\s*(.+?)\s*$/
/** 只认包名形状：同一份 patch 里 model / preset 行也写 name:，带空格的会被挡掉，剩下再用「装没装」筛 */
const PACKAGE_NAME = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i

function unquote(value: string): string {
  const trimmed = value.trim()
  const head = trimmed[0]
  if ((head === '"' || head === "'") && trimmed.endsWith(head)) return trimmed.slice(1, -1)
  return trimmed.split(' #')[0]?.trim() ?? ''
}

/**
 * 逐行扫 cordis.patch.yml，只为拿「条目 id → 包名」。
 *
 * 不引 YAML 库（运行期零第三方依赖），也不解析再序列化：这份文件带大量注释，
 * 洗一遍就没了。拿不准的行宁可漏，后面还有「包装没装」这道筛。
 */
async function patchEntries(profileDir: string): Promise<Array<{ id: string; name: string }>> {
  let raw: string
  try {
    raw = await readFile(join(profileDir, 'cordis.patch.yml'), 'utf8')
  } catch {
    return []
  }

  const entries: Array<{ id: string; name: string }> = []
  let id: string | null = null
  for (const line of raw.split(/\r?\n/)) {
    const idMatch = PATCH_ID.exec(line)
    if (idMatch !== null) {
      id = idMatch[1] ?? null
      continue
    }
    const nameMatch = PATCH_NAME.exec(line)
    if (nameMatch === null || id === null) continue
    const name = unquote(nameMatch[1] ?? '')
    if (PACKAGE_NAME.test(name)) entries.push({ id, name })
    // 每个条目只取紧随其后的第一个 name，后面的 config 段不再算
    id = null
  }
  return entries
}

function manifestPathFor(profileDir: string, name: string): string | null {
  try {
    const resolved = createRequire(join(profileDir, 'package.json')).resolve(`${name}/package.json`)
    if (existsSync(resolved)) return resolved
  } catch {
    // 包没开 `./package.json` 出口时退到路径拼接
  }
  const direct = join(profileDir, 'node_modules', name, 'package.json')
  return existsSync(direct) ? direct : null
}

function readPlugin(
  profileDir: string,
  name: string,
  id: string,
  warn: (plugin: string, message: string) => void,
  warnMissing: boolean,
): InstalledPlugin | null {
  const file = manifestPathFor(profileDir, name)
  if (file === null) {
    if (warnMissing) warn(name, `找不到 ${name} 的 package.json（装了但没装好），跳过`)
    return null
  }

  const manifest = readJson(file)
  if (!isPlainObject(manifest)) {
    warn(name, `读不了 ${name} 的 package.json，跳过`)
    return null
  }

  const peers: Record<string, string> = {}
  if (isPlainObject(manifest.peerDependencies)) {
    for (const [peer, range] of Object.entries(manifest.peerDependencies)) {
      if (typeof range !== 'string') continue
      if (peer === DSH_PACKAGE || peer.startsWith(DSH_PEER_PREFIX)) peers[peer] = range
    }
  }

  // 非法范围（不是字符串）不在这里判，也不丢掉：交给宿主，它一律算不满足
  const engines = isPlainObject(manifest.engines) ? manifest.engines : {}
  const enginesDsh =
    engines.dsh === undefined ? undefined : typeof engines.dsh === 'string' ? engines.dsh : String(engines.dsh)

  return {
    id,
    name: typeof manifest.name === 'string' && manifest.name !== '' ? manifest.name : name,
    version: typeof manifest.version === 'string' ? manifest.version : '',
    ...(enginesDsh === undefined ? {} : { enginesDsh }),
    ...(peers[DSH_PACKAGE] === undefined ? {} : { peerDsh: peers[DSH_PACKAGE] }),
    ...(Object.keys(peers).length === 0 ? {} : { peerDependencies: peers }),
  }
}

/**
 * 读 profile 里装了哪些插件：package.json 依赖 + 只挂在 cordis.patch.yml 的条目。
 * 单个插件读不到只回调 warning 并跳过，不中断整轮快检。
 */
export async function readInstalled(
  profileDir: string,
  options: ReadInstalledOptions = {},
): Promise<InstalledPlugin[]> {
  const warn = (plugin: string, message: string): void => {
    options.onWarning?.({ plugin, kind: 'compat', message })
  }

  const profile = readJson(join(profileDir, 'package.json'))
  if (!isPlainObject(profile)) return []

  const plugins: InstalledPlugin[] = []
  const seen = new Set<string>()

  const dependencies = isPlainObject(profile.dependencies) ? profile.dependencies : {}
  for (const name of Object.keys(dependencies).sort()) {
    const plugin = readPlugin(profileDir, name, name, warn, true)
    if (plugin === null) continue
    plugins.push(plugin)
    seen.add(name)
  }

  // 只挂 patch、没写进依赖的插件（宿主自带的官方包解析不到，静默跳过）
  for (const entry of await patchEntries(profileDir)) {
    if (seen.has(entry.name)) continue
    const plugin = readPlugin(profileDir, entry.name, entry.id, warn, false)
    if (plugin === null) continue
    plugins.push(plugin)
    seen.add(entry.name)
  }

  return plugins
}
