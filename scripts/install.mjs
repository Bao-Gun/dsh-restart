#!/usr/bin/env node
/**
 * dsh-restart 安装脚本：把本仓库链进 DSH web profile，并让 profile 的 cordis patch 认领它。
 *
 * 默认 dry-run：只读 profile，打印将要做的每一项改动；加 --apply 才写。
 * --verify：在克隆出来的临时 DSH_HOME 里重做一遍安装（按平台依次试 cp 候选：clonefile / reflink / 普通拷贝），另起一个 port=0 的实例，
 *          探到 /health 200 且 /dsh-restart/api/status 200 才算通过，随后回收进程组、删除临时目录。
 *
 * 只使用 node: 内置模块，不引入第三方依赖，也不参与 tsc。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PLUGIN_NAME = 'dsh-restart'
export const PLUGIN_ID = 'restart-button'
export const LEGACY_LINK_NAME = 'dsh-restart-update'
export const STATUS_ROUTE = '/dsh-restart/api/status'
export const REQUIRED_ARTIFACTS = ['lib/index.js', 'lib/client.js', 'lib/helper.js']

export const REPO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const DEFAULT_PROFILE_DIR = process.env.DSH_PROFILE_DIR
  ? resolve(process.env.DSH_PROFILE_DIR)
  : join(homedir(), '.dsh', 'profiles', 'web')

export class InstallError extends Error {
  constructor(message) {
    super(message)
    this.name = 'InstallError'
  }
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms))
}

async function readTextFile(path, label) {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') throw new InstallError(`缺少 ${label}: ${path}`)
    throw error
  }
}

async function readJsonFile(path, label) {
  const text = await readTextFile(path, label)
  try {
    return { text, value: JSON.parse(text) }
  } catch (error) {
    throw new InstallError(`${label} 不是合法 JSON: ${path}（${error.message}）`)
  }
}

/** 仓库里的 cordis.patch.yml 是 patch 片段的唯一来源；安装时原样追加，避免脚本与文件两份内容漂移。 */
export async function readPatchSnippet(repoDir = REPO_DIR) {
  const path = join(repoDir, 'cordis.patch.yml')
  const text = (await readTextFile(path, 'cordis.patch.yml 片段')).trim()
  if (!text.startsWith('- insert:')) {
    throw new InstallError(`${path} 必须以 "- insert:" 开头（顶层 - id 对不存在的条目不会新增）`)
  }
  return text
}

/**
 * 计算 package.json 依赖改动。linkTarget 形如 "link:/abs/path"。
 * 只返回计划，不写文件；已一致时 nextText 原样返回。
 */
export function planDependency(packageText, linkTarget) {
  let pkg
  try {
    pkg = JSON.parse(packageText)
  } catch (error) {
    throw new InstallError(`profile package.json 不是合法 JSON（${error.message}）`)
  }
  if (pkg === null || typeof pkg !== 'object' || Array.isArray(pkg)) {
    throw new InstallError('profile package.json 顶层必须是对象')
  }
  if (pkg.dependencies === undefined) pkg.dependencies = {}
  if (pkg.dependencies === null || typeof pkg.dependencies !== 'object' || Array.isArray(pkg.dependencies)) {
    throw new InstallError('profile package.json 的 dependencies 必须是对象')
  }
  const previous = typeof pkg.dependencies[PLUGIN_NAME] === 'string' ? pkg.dependencies[PLUGIN_NAME] : null
  if (previous === linkTarget) {
    return { kind: 'skip', name: PLUGIN_NAME, previous, next: linkTarget, nextText: packageText }
  }
  pkg.dependencies[PLUGIN_NAME] = linkTarget
  const indentMatch = packageText.match(/\n( +)"/)
  const spaces = indentMatch ? indentMatch[1].length : 2
  return {
    kind: previous === null ? 'add' : 'update',
    name: PLUGIN_NAME,
    previous,
    next: linkTarget,
    nextText: JSON.stringify(pkg, null, spaces) + '\n',
  }
}

/**
 * 只认 cordis patch 的 insert 列表；顶层 "- id: restart-button" 对不存在的条目只会告警，不算安装。
 * 判定以 id 为准：同 id 的手工条目即使把 name 改成别名也算已安装（避免重复 id），由调用方告警。
 */
export function inspectPatchEntry(patchText) {
  const lines = String(patchText).split(/\r?\n/)
  let inInsert = false
  let sawId = false
  let sawExpectedName = false
  const finishBlock = () => {
    const matched = inInsert && sawId
    const result = matched ? { present: true, nameMatches: sawExpectedName } : null
    inInsert = false
    sawId = false
    sawExpectedName = false
    return result
  }
  for (const line of lines) {
    if (/^-\s+insert:\s*$/.test(line)) {
      const done = finishBlock()
      if (done) return done
      inInsert = true
      continue
    }
    if (line.trim() !== '' && /^\S/.test(line)) {
      const done = finishBlock()
      if (done) return done
      continue
    }
    if (!inInsert) continue
    if (/^\s+-\s+id:\s*['"]?restart-button['"]?\s*$/.test(line)) sawId = true
    else if (/^\s+name:\s*['"]?dsh-restart['"]?\s*$/.test(line)) sawExpectedName = true
  }
  return finishBlock() ?? { present: false, nameMatches: false }
}

export function hasPatchEntry(patchText) {
  return inspectPatchEntry(patchText).present
}

/** 幂等追加：已有同 id 的 insert 块时原样返回。 */
export function appendPatchEntry(patchText, snippet) {
  const text = String(patchText)
  const block = String(snippet).trim()
  if (!block.startsWith('- insert:')) throw new InstallError('patch 片段必须以 "- insert:" 开头')
  if (hasPatchEntry(text)) return { changed: false, text }
  const base = text.replace(/[\r\n]+$/, '')
  return { changed: true, text: base === '' ? block + '\n' : `${base}\n\n${block}\n` }
}

/** 计算 node_modules/dsh-restart 的链接动作：指向本仓库则 keep；真实目录/文件不覆盖，标记 blocked。 */
export async function planPluginLink(profileDir, repoDir = REPO_DIR) {
  const path = join(profileDir, 'node_modules', PLUGIN_NAME)
  let info
  try {
    info = await lstat(path)
  } catch (error) {
    if (error && error.code === 'ENOENT') return { kind: 'install', reason: 'absent', path }
    throw error
  }
  if (info.isSymbolicLink()) {
    const target = await readlink(path)
    const resolved = isAbsolute(target) ? target : resolve(dirname(path), target)
    const [actual, wanted] = await Promise.all([
      realpath(resolved).catch(() => null),
      realpath(repoDir).catch(() => repoDir),
    ])
    if (actual !== null && actual === wanted) return { kind: 'keep', reason: 'points-to-repo', path, target }
    return { kind: 'install', reason: 'other-target', path, previous: target }
  }
  return { kind: 'blocked', reason: info.isDirectory() ? 'real-directory' : 'real-file', path }
}

/** 只删除「名字是旧插件、且指向已不存在目标」的软链；真实目录、目标存在的链接都不动。 */
export async function planDanglingLink(profileDir) {
  const path = join(profileDir, 'node_modules', LEGACY_LINK_NAME)
  let info
  try {
    info = await lstat(path)
  } catch (error) {
    if (error && error.code === 'ENOENT') return { kind: 'none', reason: 'absent', path }
    throw error
  }
  if (!info.isSymbolicLink()) return { kind: 'none', reason: 'not-symlink', path }
  const target = await readlink(path)
  const resolved = isAbsolute(target) ? target : resolve(dirname(path), target)
  if (existsSync(resolved)) return { kind: 'none', reason: 'target-exists', path, target }
  return { kind: 'remove', path, target, resolved }
}

/** 安装前校验仓库构建产物与 dsh.client 声明；任何一项不通过都不应写 profile。 */
export async function validateRepo(repoDir = REPO_DIR) {
  const checks = []
  for (const relative of REQUIRED_ARTIFACTS) {
    const path = join(repoDir, relative)
    const info = await stat(path).catch(() => null)
    const ok = Boolean(info && info.isFile() && info.size > 0)
    checks.push({
      name: `构建产物 ${relative}`,
      ok,
      detail: info && info.isFile() ? `${info.size} bytes${info.size > 0 ? '' : '（空文件，通常是构建失败残留）'}` : '缺失',
    })
  }
  let pkg = null
  let parseError = null
  try {
    pkg = JSON.parse(await readFile(join(repoDir, 'package.json'), 'utf8'))
  } catch (error) {
    parseError = error.message
  }
  const client = pkg && pkg.dsh && typeof pkg.dsh.client === 'object' && pkg.dsh.client !== null ? pkg.dsh.client : null
  checks.push({
    name: 'package.json dsh.client 声明',
    ok: Boolean(client),
    detail: client ? `platform=${client.platform ?? '未声明'}` : parseError ?? '缺少 dsh.client',
  })
  checks.push({
    name: 'dsh.client.platform = web',
    ok: Boolean(client && client.platform === 'web'),
    detail: client ? String(client.platform ?? '未声明') : '无 client 声明',
  })
  return { ok: checks.every((check) => check.ok), checks }
}

/** 只读地生成安装计划：不写 package.json、不写 patch、不动软链。 */
export async function buildPlan({ repoDir = REPO_DIR, profileDir = DEFAULT_PROFILE_DIR } = {}) {
  const profilePackagePath = join(profileDir, 'package.json')
  const patchPath = join(profileDir, 'cordis.patch.yml')
  const { text: packageText } = await readJsonFile(profilePackagePath, 'profile package.json')
  const patchText = existsSync(patchPath) ? await readFile(patchPath, 'utf8') : ''
  const snippet = await readPatchSnippet(repoDir)
  const linkTarget = `link:${repoDir}`

  const dependency = planDependency(packageText, linkTarget)
  const patchInspect = inspectPatchEntry(patchText)
  const appended = appendPatchEntry(patchText, snippet)
  const patch = { kind: appended.changed ? 'patch:append' : 'patch:skip', ...appended }
  const pluginLink = await planPluginLink(profileDir, repoDir)
  const link = await planDanglingLink(profileDir)
  const validation = await validateRepo(repoDir)

  const actions = [
    {
      kind: `dependency:${dependency.kind}`,
      target: 'package.json',
      detail:
        dependency.kind === 'skip'
          ? `dependencies.${PLUGIN_NAME} 已是 ${linkTarget}`
          : `dependencies.${PLUGIN_NAME} ${dependency.kind === 'add' ? '新增' : '更新为'} ${linkTarget}${dependency.previous ? `（原 ${dependency.previous}）` : ''}`,
    },
    {
      kind: patch.kind,
      target: 'cordis.patch.yml',
      detail: appended.changed
        ? `追加 insert 块（id: ${PLUGIN_ID} / name: ${PLUGIN_NAME}）`
        : `已有 insert 块（id: ${PLUGIN_ID} / name: ${PLUGIN_NAME}）`,
    },
    {
      kind: `link:${pluginLink.kind}`,
      target: `node_modules/${PLUGIN_NAME}`,
      detail:
        pluginLink.kind === 'keep'
          ? `已指向本仓库: ${repoDir}`
          : pluginLink.kind === 'install'
            ? `建软链 -> ${repoDir}${pluginLink.previous ? `（原 ${pluginLink.previous}）` : ''}`
            : `拒绝覆盖真实${pluginLink.reason === 'real-directory' ? '目录' : '文件'}：请先手工移走`,
    },
    {
      kind: link.kind === 'remove' ? 'link:remove' : 'link:none',
      target: `node_modules/${LEGACY_LINK_NAME}`,
      detail:
        link.kind === 'remove'
          ? `删除悬空软链 -> ${link.target}`
          : link.reason === 'target-exists'
            ? `保留（目标存在: ${link.target}）`
            : link.reason === 'not-symlink'
              ? '保留（不是软链）'
              : '不存在',
    },
  ]

  const warnings = []
  if (!validation.ok) warnings.push('仓库校验未通过：修复构建产物 / dsh.client 后再 --apply')
  if (pluginLink.kind === 'blocked') warnings.push(`node_modules/${PLUGIN_NAME} 是真实${pluginLink.reason === 'real-directory' ? '目录' : '文件'}，脚本不会覆盖`)
  if (patchInspect.present && !patchInspect.nameMatches) {
    warnings.push(`已有 id: ${PLUGIN_ID} 的 insert 块但 name 不是 ${PLUGIN_NAME}，按已安装处理；若不是手工改过，请检查 cordis.patch.yml`)
  }

  return {
    repoDir,
    profileDir,
    profilePackagePath,
    patchPath,
    linkTarget,
    validation,
    dependency,
    patch,
    pluginLink,
    link,
    actions,
    warnings,
    snippet,
    changed:
      dependency.kind !== 'skip' ||
      patch.changed ||
      pluginLink.kind === 'install' ||
      pluginLink.kind === 'blocked' ||
      link.kind === 'remove',
  }
}

export function formatPlan(plan, mode = 'dry-run') {
  const apply = mode === 'apply'
  const verify = mode === 'verify'
  const lines = []
  lines.push(`dsh-restart 安装计划（${apply ? '--apply，将写入' : verify ? '--verify，真实 profile 只读' : 'dry-run'}）`)
  lines.push(`仓库: ${plan.repoDir}`)
  lines.push(`profile: ${plan.profileDir}`)
  lines.push(`链接目标: ${plan.linkTarget}`)
  lines.push(apply ? '将写入:' : '改动:')
  for (const action of plan.actions) {
    lines.push(`  [${action.kind}] ${action.target}: ${action.detail}`)
  }
  lines.push('校验（安装前）:')
  for (const check of plan.validation.checks) {
    lines.push(`  ${check.ok ? '✓' : '✗'} ${check.name}: ${check.detail}`)
  }
  for (const warning of plan.warnings) lines.push(`! ${warning}`)
  const count = plan.actions.filter((action) => !action.kind.endsWith(':skip') && !action.kind.endsWith(':none')).length
  if (plan.pluginLink.kind === 'blocked') {
    lines.push('结论: 有阻塞项（真实目录/文件挡路），--apply 会拒绝执行；未写任何文件。')
  } else if (plan.changed) {
    if (apply) lines.push(`结论: ${count} 项将写入 profile（下列顺序执行，patch 最后写）。`)
    else if (verify) lines.push(`结论: 真实 profile 有 ${count} 项待改动，本次 --verify 只写克隆、不动真实 profile。`)
    else lines.push(`结论: ${count} 项待改动；dry-run 未写任何文件，加 --apply 执行。`)
  } else {
    lines.push(`结论: 全部已一致，无需改动（幂等检查通过）${apply ? '，未写任何文件。' : verify ? '；真实 profile 未改动。' : '；dry-run 未写任何文件。'}`)
  }
  return lines.join('\n')
}

/**
 * 真正写盘。只应由 CLI 在 --apply 且校验通过后调用。
 * 顺序有意为之：patch 最后写。最坏失败态是「依赖已声明、软链已建、但配置还没认领」，
 * 此时没有任何代码引用插件，dsh web 照常启动；反过来（配置认领了不存在的包）会留一个静默失效的条目。
 */
export async function applyPlan(plan) {
  if (!plan.validation.ok) throw new InstallError('仓库校验未通过，拒绝写入 profile')
  if (plan.pluginLink.kind === 'blocked') {
    throw new InstallError(`node_modules/${PLUGIN_NAME} 是真实${plan.pluginLink.reason === 'real-directory' ? '目录' : '文件'}，拒绝覆盖：${plan.pluginLink.path}`)
  }
  const table = []
  const applied = []
  const run = async (label, skip, fn) => {
    if (skip) {
      table.push(`- ${label}: 已一致，跳过`)
      return
    }
    try {
      const note = await fn()
      table.push(`✓ ${label}${note ? `：${note}` : ''}`)
      applied.push(note ?? label)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      table.push(`✗ ${label}：${reason}`)
      const message = [
        '安装中途失败，已停止。',
        '步骤:',
        ...table.map((row) => `  ${row}`),
        `已完成: ${applied.length ? applied.join('；') : '无'}`,
        '重跑本脚本即可自愈（幂等：已完成的步骤会跳过或覆盖为一致状态）。',
      ]
      throw new InstallError(message.join('\n'))
    }
  }

  await run('package.json 依赖', plan.dependency.kind === 'skip', async () => {
    await writeFile(plan.profilePackagePath, plan.dependency.nextText)
    return `${plan.dependency.kind} ${PLUGIN_NAME}`
  })
  await run(`删除悬空软链 ${LEGACY_LINK_NAME}`, plan.link.kind !== 'remove', async () => {
    await rm(plan.link.path, { force: true })
    return `删除 ${LEGACY_LINK_NAME}`
  })
  await run(`node_modules/${PLUGIN_NAME} 软链`, plan.pluginLink.kind !== 'install', async () => {
    await mkdir(dirname(plan.pluginLink.path), { recursive: true })
    await rm(plan.pluginLink.path, { force: true })
    await symlink(plan.repoDir, plan.pluginLink.path, 'dir')
    return `-> ${plan.repoDir}`
  })
  await run('cordis.patch.yml', !plan.patch.changed, async () => {
    await writeFile(plan.patchPath, plan.patch.text)
    return '追加 insert 块'
  })
  return { changed: applied.length > 0, applied, steps: table }
}

/** 在副本里重做安装：写依赖、追加 patch、建 link（不跑 pnpm，避免网络与脚本）。 */
async function installIntoCopy(profileCopy, repoDir) {
  const packagePath = join(profileCopy, 'package.json')
  const dependency = planDependency(await readFile(packagePath, 'utf8'), `link:${repoDir}`)
  if (dependency.kind !== 'skip') await writeFile(packagePath, dependency.nextText)

  const patchPath = join(profileCopy, 'cordis.patch.yml')
  const patchText = existsSync(patchPath) ? await readFile(patchPath, 'utf8') : ''
  const appended = appendPatchEntry(patchText, await readPatchSnippet(repoDir))
  if (appended.changed) await writeFile(patchPath, appended.text)

  const linkPath = join(profileCopy, 'node_modules', PLUGIN_NAME)
  await mkdir(dirname(linkPath), { recursive: true })
  await rm(linkPath, { recursive: true, force: true })
  await symlink(repoDir, linkPath, 'dir')

  const dangling = await planDanglingLink(profileCopy)
  if (dangling.kind === 'remove') await rm(dangling.path, { force: true })
}

export const VERIFY_DIR_PREFIX = 'dsh-restart-verify-'

/**
 * 克隆候选表：与 src/server/clone.ts 的 cloneCandidates 完全一致（这里是纯 JS，不能 import TS），
 * test/clone.test.ts 把两边钉在一起——改表必须同批改两个文件。
 *
 * - darwin：APFS clonefile（-c）优先，不支持时退回真拷贝；
 * - linux：--reflink=auto 在 btrfs/xfs 上真 CoW，ext4 上自动退化成整拷，老 coreutils 不认就退回 -R；
 * - 其它平台只给普通 -R。绝不用硬链接（-l）：会共享 inode，副本里的写入会落到线上 profile。
 */
export function cloneCandidateList(source, dest, platform = process.platform) {
  if (platform === 'darwin') return [['-c', '-R', source, dest], ['-R', source, dest]]
  if (platform === 'linux') return [['--reflink=auto', '-R', source, dest], ['-R', source, dest]]
  return [['-R', source, dest]]
}

/** 首选参数（保留旧签名，已有调用方不受影响）；--verify 会打印实际用的那一组。 */
export function cloneArgs(source, dest, platform = process.platform) {
  return cloneCandidateList(source, dest, platform)[0]
}

/** cp 的参数里前两段是选项，最后两段是 source / dest；日志只打印选项，路径另外给。 */
function cloneOptionLabel(args) {
  return `cp ${args.slice(0, -2).join(' ')}`
}

/** 独立实例的启动参数：端口 0 由宿主分配，绝不碰已有的 3080。 */
export function launchArgs({ profileName = 'web', port = 0 } = {}) {
  return ['--profile', profileName, '--port', String(port), '--no-open']
}

/** 清理顺序固定：先回收进程组，再删临时目录（反过来会来不及读实例日志）。 */
export function cleanupSequence() {
  return ['kill-process-group', 'remove-temp-dir']
}

/** 只同步 profile 的 pnpm-lock.yaml，不碰 node_modules；失败/超时只告警，不算安装失败。 */
/**
 * 是否需要同步 lockfile。只在真的写了东西、且这次改动与依赖有关时才同步：
 * - 本次新增/更新了依赖 → 要同步；
 * - 依赖已存在但这次补写了 patch（上次半安装后的自愈）→ 也要同步，否则会出现
 *   package.json 里有 link: 而 pnpm-lock.yaml 里没有 dsh-restart 的不一致态。
 */
export function shouldSyncLockfile(applied, plan) {
  if (!applied.changed) return false
  return plan.dependency.kind !== 'skip' || plan.patch.changed
}

export function syncLockfile({ profileDir = DEFAULT_PROFILE_DIR, timeoutMs = 20000, run = runPnpmLockfileOnly } = {}) {
  const started = Date.now()
  const result = run(profileDir, timeoutMs)
  return { ...result, elapsedMs: Date.now() - started }
}

function runPnpmLockfileOnly(profileDir, timeoutMs) {
  const result = spawnSync('pnpm', ['install', '--offline', '--ignore-scripts', '--lockfile-only'], {
    cwd: profileDir,
    encoding: 'utf8',
    timeout: timeoutMs,
    env: { ...process.env, CI: '1' },
  })
  if (result.error) {
    const timedOut = result.error.code === 'ETIMEDOUT' || result.signal === 'SIGTERM'
    return {
      ok: false,
      reason: timedOut ? `超时 ${timeoutMs}ms` : result.error.message,
      output: (result.stderr || '').slice(-400),
    }
  }
  if (result.status !== 0) {
    return { ok: false, reason: `exit ${result.status}`, output: (result.stderr || result.stdout || '').slice(-400) }
  }
  return { ok: true, output: (result.stdout || '').slice(-400) }
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise((done) => {
    const timer = setTimeout(() => done(false), timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      done(true)
    })
  })
}

async function waitForLaunchUrl(getLog, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  const pattern = /dsh web:\s+(https?:\/\/[^\s]+)/
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new InstallError(`dsh 实例提前退出（code=${child.exitCode}）`)
    const match = pattern.exec(getLog())
    if (match) return match[1]
    await sleep(200)
  }
  throw new InstallError(`等待 dsh 启动 URL 超时（${timeoutMs}ms）`)
}

async function bootstrapCookie(url) {
  const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) })
  const raw =
    typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie')].filter(Boolean)
  const cookie = raw.map((value) => String(value).split(';')[0].trim()).find((value) => value.includes('='))
  if (!cookie) throw new InstallError(`启动 URL 未下发认证 cookie（HTTP ${response.status}）`)
  return cookie
}

async function pollReady(origin, cookie, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let last = '未发出请求'
  while (Date.now() < deadline) {
    try {
      const health = await fetch(`${origin}/health`, {
        headers: { cookie },
        signal: AbortSignal.timeout(3000),
      })
      last = `/health ${health.status}`
      if (health.status === 200) {
        const status = await fetch(`${origin}${STATUS_ROUTE}`, {
          headers: { cookie, 'x-dsh-restart': '1' },
          signal: AbortSignal.timeout(3000),
        })
        const text = await status.text()
        last = `/health 200, status ${status.status}`
        if (status.status === 200) {
          let body = null
          try {
            body = JSON.parse(text)
          } catch {
            body = null
          }
          if (body && body.ok === true) return { health: 200, status: 200, body }
          last = `status 200 但 body.ok 不为 true: ${text.slice(0, 200)}`
        } else {
          last = `status ${status.status}: ${text.slice(0, 200)}`
        }
      }
    } catch (error) {
      last = `请求失败: ${error.message}`
    }
    await sleep(300)
  }
  throw new InstallError(`等待就绪超时（${timeoutMs}ms，最后状态: ${last}）`)
}

/**
 * 在克隆的 DSH_HOME 里验证「插件可加载且 status 200」。
 * 无论成功失败都回收进程组、删除临时目录；绝不复用 3080。
 */
export async function runVerify({
  repoDir = REPO_DIR,
  profileDir = DEFAULT_PROFILE_DIR,
  timeoutMs = 30000,
  log = () => {},
} = {}) {
  const started = Date.now()
  const steps = []
  let home = null
  let child = null
  let logBuffer = ''
  let result = { ok: false }

  const record = (name, ok, detail) => {
    steps.push({ name, ok, detail })
    log(`${ok ? '✓' : '✗'} ${name}${detail ? `：${detail}` : ''}`)
  }

  try {
    home = await mkdtemp(join(tmpdir(), VERIFY_DIR_PREFIX))
    const profilesDir = join(home, 'profiles')
    await mkdir(profilesDir, { recursive: true })
    const profileCopy = join(profilesDir, 'web')
    // 按平台给的候选表逐个试；每一次失败先清掉可能留下的半个目标目录，再换下一组参数。
    const cloneFailures = []
    let cloneLabel = null
    for (const args of cloneCandidateList(profileDir, profileCopy)) {
      const copied = spawnSync('cp', args, { encoding: 'utf8' })
      if (copied.status === 0) {
        cloneLabel = cloneOptionLabel(args)
        break
      }
      const detail = copied.error
        ? copied.error.message
        : (copied.stderr || '').trim() || `exit ${copied.status}`
      cloneFailures.push(`${cloneOptionLabel(args)}：${detail}`)
      await rm(profileCopy, { recursive: true, force: true }).catch(() => {})
    }
    if (cloneLabel === null) {
      throw new InstallError(`克隆 profile 失败：${cloneFailures.join('；')}`)
    }
    record('clone', true, `${cloneLabel} → ${profileCopy}`)

    await installIntoCopy(profileCopy, repoDir)
    record('install-copy', true, `副本内写依赖、追加 patch、link → ${repoDir}`)

    const dshBin = process.env.DSH_BIN || 'dsh'
    child = spawn(dshBin, launchArgs(), {
      cwd: home,
      env: { ...process.env, DSH_HOME: home, DSH_DAEMON_OPEN_BROWSER: '0' },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const absorb = (chunk) => {
      logBuffer = (logBuffer + String(chunk)).slice(-8000)
    }
    child.stdout?.on('data', absorb)
    child.stderr?.on('data', absorb)
    child.on('error', (error) => {
      absorb(`[spawn error] ${error.message}`)
    })
    if (!child.pid) throw new InstallError(`无法启动 dsh（${dshBin}）：检查 DSH_BIN 或 PATH`)

    const url = await waitForLaunchUrl(() => logBuffer, child, timeoutMs)
    record('spawn', true, url.replace(/\?.*$/, '?token=***'))

    const origin = new URL(url).origin
    const cookie = await bootstrapCookie(url)
    record('auth', true, '拿到认证 cookie')

    const ready = await pollReady(origin, cookie, timeoutMs)
    record('probe', true, `/health 200；status 200（port=${ready.body.port}, health=${ready.body.health}）`)
    result = { ok: true, url: origin, status: ready.body }
  } catch (error) {
    result = { ok: false, error: error instanceof Error ? error.message : String(error) }
    steps.push({ name: 'error', ok: false, detail: result.error })
  } finally {
    if (child && child.pid) {
      try {
        process.kill(-child.pid, 'SIGTERM')
      } catch {
        // 进程可能已经自己退出。
      }
      const exited = await waitForExit(child, 5000)
      if (!exited) {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          // 同上。
        }
        await waitForExit(child, 2000)
      }
      record('kill', true, `进程组 ${child.pid} 已回收（SIGTERM${exited ? '' : '→SIGKILL'}）`)
    }
    if (home) {
      await rm(home, { recursive: true, force: true }).catch(() => {})
      const cleaned = !existsSync(home)
      record('cleanup', cleaned, `临时目录已删除: ${cleaned}（${home}）`)
    }
  }

  return { ...result, elapsedMs: Date.now() - started, steps, logTail: logBuffer.slice(-3000) }
}

function parseArgs(argv) {
  const options = { apply: false, verify: false, help: false, repoDir: REPO_DIR, profileDir: DEFAULT_PROFILE_DIR }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--apply') options.apply = true
    else if (arg === '--verify') options.verify = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--profile') {
      const value = argv[index + 1]
      if (!value) throw new InstallError('--profile 需要一个目录参数')
      options.profileDir = resolve(value)
      index += 1
    } else if (arg === '--repo') {
      const value = argv[index + 1]
      if (!value) throw new InstallError('--repo 需要一个目录参数')
      options.repoDir = resolve(value)
      index += 1
    } else {
      throw new InstallError(`未知参数: ${arg}`)
    }
  }
  return options
}

const HELP = `用法: node scripts/install.mjs [--profile <dir>] [--repo <dir>] [--apply] [--verify]

默认 dry-run：只打印计划，不写任何文件。
  --apply    真正写入 profile 的 package.json / cordis.patch.yml，并删除悬空软链；成功后补 pnpm --lockfile-only
  --verify   在克隆的临时 DSH_HOME 里起 port=0 实例，探 /health 与 status 200（macOS 先试 cp -c，Linux 先试 --reflink=auto，失败都退回 cp -R）
  --profile  默认 ~/.dsh/profiles/web
  --repo     默认本仓库根目录
`

export async function main(argv = process.argv.slice(2), io = { out: console.log, err: console.error }) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    io.err(error.message)
    return 1
  }
  if (options.help) {
    io.out(HELP.trimEnd())
    return 0
  }

  const plan = await buildPlan({ repoDir: options.repoDir, profileDir: options.profileDir })
  io.out(formatPlan(plan, options.apply ? 'apply' : options.verify ? 'verify' : 'dry-run'))

  if (!plan.validation.ok) {
    io.err('仓库校验未通过，停止。')
    return 1
  }

  if (options.verify) {
    io.out('')
    io.out('== 副本验证 ==')
    const verify = await runVerify({
      repoDir: options.repoDir,
      profileDir: options.profileDir,
      log: (line) => io.out(line),
    })
    io.out(`验证结果: ${verify.ok ? 'PASS' : 'FAIL'}（${verify.elapsedMs}ms）`)
    if (!verify.ok) {
      io.err(`失败原因: ${verify.error ?? '未知'}`)
      if (verify.logTail) io.err(`---- 实例日志尾部 ----\n${verify.logTail}`)
      return 1
    }
  }

  if (options.apply) {
    const applied = await applyPlan(plan)
    io.out(`已应用: ${applied.changed ? applied.applied.join('；') : '无改动（全部已一致）'}`)
    // 依赖已存在但这次补写了 patch（常见于上次半安装后的自愈）时也要同步，否则 package.json 有 link: 而 lockfile 没有。
    if (shouldSyncLockfile(applied, plan)) {
      const lock = await syncLockfile({ profileDir: options.profileDir })
      if (lock.ok) {
        io.out(`✓ lockfile: pnpm install --lockfile-only 已同步（${lock.elapsedMs}ms）`)
      } else {
        io.out(`! lockfile 未同步（${lock.reason}）：不影响插件加载，但 pnpm install --frozen-lockfile 可能报 OUTDATED_LOCKFILE`)
        io.out(`  可稍后在 profile 目录手动跑: pnpm install --offline --ignore-scripts --lockfile-only`)
      }
    }
    io.out('下一步: 重启 dsh web（或用 dsh_restart 工具）让 profile 重新加载。')
  } else if (options.verify) {
    io.out('（验证完成：真实 profile 未改动。确认后加 --apply。）')
  } else {
    io.out('（dry-run 结束：未写任何文件。确认后加 --apply。）')
  }
  return 0
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    })
}
