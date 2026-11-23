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

/**
 * 清单里一个形状不合规的字段。
 *
 * 这类清单宿主会**抛错并停用插件**（`dsh-app-boot` 的 `objectOf` / `engines.dsh` /
 * `peerDependencies[name]` 三处都会 throw），所以不能当「没有要求」放过去。
 */
export interface ManifestProblem {
  /** 字段路径，例如 `engines`、`engines.dsh`、`peerDependencies["@deepseek-ai/dsh"]` */
  field: string
  /** 期望的形状 */
  expected: string
  /** 实际拿到的值（JSON 片段，已截断） */
  actual: string
}

/** 一个装进 profile 的插件。 */
export interface InstalledPlugin {
  /** profile 里的身份：依赖直接就是包名，只挂在 patch 里的用条目 id */
  id: string
  name: string
  version: string
  /** 插件自己声明的最低 dsh 版本；存在时宿主只认它 */
  enginesDsh?: string
  /**
   * `@deepseek-ai/dsh` 那一条 peer 范围。
   * **仅展示用**：判定只认 `peerDependencies`（完整集合），只有手写对象缺它时才退到这里。
   */
  peerDsh?: string
  /**
   * 完整的 dsh peer 集合。宿主的规则会逐个检查 `@deepseek-ai/dsh` 与
   * `@deepseek-ai/dsh-*`，只留 peerDsh 会让 dsh-tools 这类 peer 悄悄漏判。
   */
  peerDependencies?: Record<string, string>
  /** 清单里形状不合规的字段；有值时直接判失败，不再交给宿主 */
  manifestProblems?: ManifestProblem[]
}

export interface ReadInstalledOptions {
  /** 单个插件读不动时回调一条 warning；默认忽略（不抛）。 */
  onWarning?: (failure: Failure) => void
}

const DSH_PACKAGE = '@deepseek-ai/dsh'
const BOOT_PACKAGE = '@deepseek-ai/dsh-app-boot'
const BOOT_ENTRY = join('node_modules', '@deepseek-ai', 'dsh-app-boot')
const OFFICIAL_SCOPE = '@deepseek-ai/'

/** 兜底：node 与全局 node_modules 通常同层（homebrew、usr/local 都是这个形状）。 */
const EXTRA_INSTALL_DIRS = [
  '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh',
  '/usr/local/lib/node_modules/@deepseek-ai/dsh',
]

const HOST_HINT =
  '可设 DSH_RESTART_DSH_DIR 指向 dsh 安装根，或 DSH_RESTART_BOOT_DIR 指向 @deepseek-ai/dsh-app-boot 目录后重试'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 读 JSON 并区分「不存在」「读不了」「解析失败」——三者对调用方的含义不一样。 */
type JsonFile =
  | { ok: true; value: unknown }
  | { ok: false; missing: boolean; message: string }

function readJsonFile(file: string): JsonFile {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    const code = isPlainObject(error) && typeof error.code === 'string' ? error.code : ''
    return {
      ok: false,
      missing: code === 'ENOENT',
      message: error instanceof Error ? error.message : String(error),
    }
  }
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch (error) {
    return { ok: false, missing: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/** 报错/展示用：把任意值截成一小段 JSON。 */
function describeValue(value: unknown): string {
  let text: string
  try {
    text = JSON.stringify(value) ?? String(value)
  } catch {
    text = String(value)
  }
  return text.length > 80 ? `${text.slice(0, 77)}...` : text
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
  const manifest = readJsonFile(join(dir, 'package.json'))
  return manifest.ok && isPlainObject(manifest.value) && manifest.value.name === DSH_PACKAGE
}

function discoveredCandidates(): string[] {
  const installDirs = [
    ...ancestorsOf(process.argv[1] ?? ''),
    join(dirname(process.execPath), '..', 'lib', 'node_modules', DSH_PACKAGE),
    ...EXTRA_INSTALL_DIRS,
  ]
  const dirs: string[] = []
  for (const dir of installDirs) {
    if (dir === '' || !isDshInstall(dir)) continue
    const boot = join(dir, BOOT_ENTRY)
    if (!dirs.includes(boot)) dirs.push(boot)
  }
  return dirs
}

/** 显式指定了根就以它为准：给错了要响亮失败，而不是悄悄换一个装好的 dsh。 */
function overrideCandidates(): string[] | null {
  const boot = process.env.DSH_RESTART_BOOT_DIR
  const install = process.env.DSH_RESTART_DSH_DIR
  const hasBoot = boot !== undefined && boot !== ''
  const hasInstall = install !== undefined && install !== ''
  if (!hasBoot && !hasInstall) return null

  const dirs: string[] = []
  if (hasBoot) dirs.push(boot as string)
  if (hasInstall) dirs.push(join(install as string, BOOT_ENTRY))
  return dirs
}

/** 只缓存成功结果；失败每次重试，避免一次环境抖动把整个进程钉在 fail-closed 上。 */
let hostModule: HostCompatibility | null = null
let hostProblem = ''
let hostTried: string[] = []

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
  if (hostModule !== null) return hostModule

  const candidates = overrideCandidates() ?? discoveredCandidates()
  hostTried = candidates
  hostProblem = '没有找到 dsh 安装目录'

  for (const dir of candidates) {
    const manifest = readJsonFile(join(dir, 'package.json'))
    if (!manifest.ok || !isPlainObject(manifest.value)) {
      hostProblem = `${dir} 里没有可读的 package.json`
      continue
    }
    const main =
      typeof manifest.value.main === 'string' && manifest.value.main !== ''
        ? manifest.value.main
        : 'lib/index.js'
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
  return null
}

/** 生产路径的运行时版本：从宿主 API 取；取不到返回空串，交给 compatFailures 报失败。 */
export function hostRuntimeVersion(): string {
  try {
    return hostCompatibility()?.getDshRuntimeVersion() ?? ''
  } catch {
    return ''
  }
}

/**
 * 把宿主给的未满足项拼成人能读的期望值。
 * peer 要带上包名（多 peer 时才知道是哪一条），engines.dsh 只留范围。
 */
function expectedOf(requirements: Record<string, string>): string {
  return Object.entries(requirements)
    .map(([field, range]) => (field === 'engines.dsh' ? range : `${field} ${range}`))
    .join(', ')
}

function manifestProblemFailures(plugin: InstalledPlugin): Failure[] {
  const name = plugin.name !== '' ? plugin.name : plugin.id
  return (plugin.manifestProblems ?? []).map((problem) => ({
    plugin: name,
    kind: 'compat',
    message: `插件 ${name} 的清单字段 ${problem.field} 形状不对（期望 ${problem.expected}，实际 ${problem.actual}）：宿主加载时会抛错并停用它，不能判为兼容`,
    expected: `${problem.field} 为 ${problem.expected}`,
    actual: problem.actual,
  }))
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
 * 安全点：取不到运行时版本、加载不到宿主判定函数、清单字段形状不对，都必须返回明确 failure。
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
    const tried = hostTried.length === 0 ? '（无候选目录）' : hostTried.join('、')
    return [
      {
        kind: 'compat',
        message: `加载不到宿主的兼容性判定（${hostProblem}；尝试过：${tried}）。${HOST_HINT}`,
        actual: runtimeVersion,
      },
    ]
  }

  const failures: Failure[] = []
  for (const plugin of plugins) {
    if (plugin.manifestProblems !== undefined && plugin.manifestProblems.length > 0) {
      failures.push(...manifestProblemFailures(plugin))
      continue
    }
    const failure = judgeOne(host, plugin, runtimeVersion)
    if (failure !== null) failures.push(failure)
  }
  return failures
}

const DSH_PEER_PREFIX = `${DSH_PACKAGE}-`
const PATCH_ID = /^\s*-\s+id:\s*(\S+)\s*$/
const PATCH_NAME = /^\s+(?:-\s+)?name:\s*(.+?)\s*$/
/**
 * 只认包名形状：npm 包名一律小写，所以不加 i 标志 —— 同一份 patch 里的模型展示名
 * （`GLM-5`、`DeepSeek V4 Pro · Bailian Token Plan`）就这样被挡掉，剩下的再按「装没装」筛。
 */
const PACKAGE_NAME = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/

/** 去掉行尾 `# 注释`：真实 patch 文件里 `- id: llm-pi-ai # magpie` 这种写法很常见。 */
function stripComment(line: string): string {
  const index = line.search(/\s#/)
  return index === -1 ? line : line.slice(0, index)
}

function unquote(value: string): string {
  const trimmed = value.trim()
  const head = trimmed[0]
  if ((head === '"' || head === "'") && trimmed.endsWith(head)) return trimmed.slice(1, -1)
  return trimmed
}

/**
 * 逐行扫 cordis.patch.yml，只为拿「条目 id → 包名」。
 *
 * 不引 YAML 库（运行期零第三方依赖），也不解析再序列化：这份文件带大量注释，
 * 洗一遍就没了。拿不准的行宁可漏，后面还有「装没装」这道筛。
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
    const bare = stripComment(line)
    const idMatch = PATCH_ID.exec(bare)
    if (idMatch !== null) {
      id = idMatch[1] ?? null
      continue
    }
    const nameMatch = PATCH_NAME.exec(bare)
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

/** 按宿主会抛错的那些形状，把清单里的 dsh 要求读出来；读不准的字段记成 problem。 */
function requirementsOf(manifest: Record<string, unknown>): {
  enginesDsh?: string
  peerDependencies?: Record<string, string>
  problems: ManifestProblem[]
} {
  const problems: ManifestProblem[] = []

  let enginesDsh: string | undefined
  if (manifest.engines !== undefined) {
    if (!isPlainObject(manifest.engines)) {
      problems.push({ field: 'engines', expected: '对象', actual: describeValue(manifest.engines) })
    } else if (manifest.engines.dsh !== undefined) {
      const range = manifest.engines.dsh
      if (typeof range === 'string') enginesDsh = range
      else {
        problems.push({
          field: 'engines.dsh',
          expected: '版本范围字符串',
          actual: describeValue(range),
        })
      }
    }
  }

  const peerDependencies: Record<string, string> = {}
  if (manifest.peerDependencies !== undefined) {
    if (!isPlainObject(manifest.peerDependencies)) {
      problems.push({
        field: 'peerDependencies',
        expected: '对象',
        actual: describeValue(manifest.peerDependencies),
      })
    } else {
      // 宿主对**任意** peer 的非字符串值都会抛，所以不只查 dsh-* 那几条
      for (const [peer, range] of Object.entries(manifest.peerDependencies)) {
        if (typeof range !== 'string') {
          problems.push({
            field: `peerDependencies[${JSON.stringify(peer)}]`,
            expected: '版本范围字符串',
            actual: describeValue(range),
          })
          continue
        }
        if (peer === DSH_PACKAGE || peer.startsWith(DSH_PEER_PREFIX)) peerDependencies[peer] = range
      }
    }
  }

  return {
    ...(enginesDsh === undefined ? {} : { enginesDsh }),
    ...(Object.keys(peerDependencies).length === 0 ? {} : { peerDependencies }),
    problems,
  }
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

  const manifest = readJsonFile(file)
  if (!manifest.ok) {
    warn(name, `读不了 ${name} 的 package.json（${manifest.message}），跳过`)
    return null
  }
  if (!isPlainObject(manifest.value)) {
    warn(name, `${name} 的 package.json 不是一个对象，跳过`)
    return null
  }

  const requirements = requirementsOf(manifest.value)
  const peerDependencies = requirements.peerDependencies

  return {
    id,
    name: typeof manifest.value.name === 'string' && manifest.value.name !== '' ? manifest.value.name : name,
    version: typeof manifest.value.version === 'string' ? manifest.value.version : '',
    ...(requirements.enginesDsh === undefined ? {} : { enginesDsh: requirements.enginesDsh }),
    ...(peerDependencies?.[DSH_PACKAGE] === undefined ? {} : { peerDsh: peerDependencies[DSH_PACKAGE] }),
    ...(peerDependencies === undefined ? {} : { peerDependencies }),
    ...(requirements.problems.length === 0 ? {} : { manifestProblems: requirements.problems }),
  }
}

/**
 * 读 profile 里装了哪些插件：package.json 依赖 + 只挂在 cordis.patch.yml 的条目。
 * 单个插件读不到只回调 warning 并跳过，不中断整轮快检；清单字段形状不对的留在
 * `manifestProblems` 里，交给 compatFailures 报成 failure。
 */
export async function readInstalled(
  profileDir: string,
  options: ReadInstalledOptions = {},
): Promise<InstalledPlugin[]> {
  const warn = (plugin: string, message: string): void => {
    options.onWarning?.({ plugin, kind: 'compat', message })
  }

  const profile = readJsonFile(join(profileDir, 'package.json'))
  if (!profile.ok) {
    // 文件不存在 = 这个 profile 还没装过插件；解析失败 = 我们看不到它装了啥，必须说出来
    if (!profile.missing) {
      warn('profile', `读不了 profile 的 package.json（${profile.message}），无法判断装了哪些插件`)
    }
    return []
  }
  if (!isPlainObject(profile.value)) {
    warn('profile', 'profile 的 package.json 不是一个对象，无法判断装了哪些插件')
    return []
  }

  const plugins: InstalledPlugin[] = []
  const seen = new Set<string>()

  const dependencies = isPlainObject(profile.value.dependencies) ? profile.value.dependencies : {}
  for (const name of Object.keys(dependencies).sort()) {
    const plugin = readPlugin(profileDir, name, name, warn, true)
    if (plugin === null) continue
    plugins.push(plugin)
    seen.add(name)
  }

  // 只挂 patch、没写进依赖的插件。官方内置包解析不到是常态（静默），
  // 第三方条目解析不到说明装坏了，要留信号。
  for (const entry of await patchEntries(profileDir)) {
    if (seen.has(entry.name)) continue
    const plugin = readPlugin(profileDir, entry.name, entry.id, warn, false)
    if (plugin !== null) {
      plugins.push(plugin)
      seen.add(entry.name)
      continue
    }
    if (!entry.name.startsWith(OFFICIAL_SCOPE)) {
      warn(
        entry.name,
        `patch 条目 ${entry.id} 指向 ${entry.name}，但它的 package.json 找不到（装了但没装好），跳过`,
      )
    }
  }

  return plugins
}
