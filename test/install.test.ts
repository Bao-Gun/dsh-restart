import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const installUrl = pathToFileURL(join(repoRoot, 'scripts', 'install.mjs')).href

/** install.mjs 是纯 JS、不参与 tsc；用变量 URL 动态 import，避免 TS7016。 */
async function loadInstall(): Promise<any> {
  return import(installUrl)
}

const tempDirs: string[] = []

async function tempDir(prefix = 'dsh-restart-install-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

async function makeRepo(): Promise<string> {
  const dir = await tempDir('dsh-restart-repo-')
  await mkdir(join(dir, 'lib'), { recursive: true })
  for (const file of ['index.js', 'client.js', 'helper.js']) await writeFile(join(dir, 'lib', file), '// built\n')
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify(
      {
        name: 'dsh-restart',
        version: '0.1.0',
        type: 'module',
        main: 'lib/index.js',
        dsh: { client: { platform: 'web', immediately: true } },
      },
      null,
      2,
    ) + '\n',
  )
  await writeFile(join(dir, 'cordis.patch.yml'), await readFile(join(repoRoot, 'cordis.patch.yml'), 'utf8'))
  return dir
}

async function makeProfile(options: { dependency?: string; patch?: string; dangling?: string } = {}): Promise<string> {
  const dir = await tempDir('dsh-restart-profile-')
  await mkdir(join(dir, 'node_modules'), { recursive: true })
  const pkg = {
    name: 'dsh-profile-web',
    private: true,
    dependencies: options.dependency === undefined ? {} : { 'dsh-restart': options.dependency },
  }
  await writeFile(join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')
  if (options.patch !== undefined) await writeFile(join(dir, 'cordis.patch.yml'), options.patch)
  if (options.dangling !== undefined) {
    await symlink(options.dangling, join(dir, 'node_modules', 'dsh-restart-update'), 'dir')
  }
  return dir
}

/** existsSync 会跟随软链，悬空链接返回 false；这里要的只是「目录项在不在」。 */
async function linkEntryExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('cordis.patch.yml 片段', () => {
  it('从仓库读取 insert 片段', async () => {
    const install = await loadInstall()
    const snippet = await install.readPatchSnippet(repoRoot)
    expect(snippet).toContain('- insert:')
    expect(snippet).toContain('id: restart-button')
    expect(snippet).toContain('name: dsh-restart')
  })

  it('片段缺失时报错而不是静默追加空内容', async () => {
    const install = await loadInstall()
    await expect(install.readPatchSnippet(await tempDir())).rejects.toThrow(/cordis\.patch\.yml/)
  })
})

describe('package.json 依赖计划', () => {
  it('没有依赖时 add', async () => {
    const install = await loadInstall()
    const plan = install.planDependency(JSON.stringify({ name: 'p', dependencies: { a: '1.0.0' } }), 'link:/repo')
    expect(plan.kind).toBe('add')
    expect(JSON.parse(plan.nextText).dependencies['dsh-restart']).toBe('link:/repo')
  })

  it('已有不同值 update，并记录旧值', async () => {
    const install = await loadInstall()
    const plan = install.planDependency(JSON.stringify({ name: 'p', dependencies: { 'dsh-restart': 'link:/old' } }), 'link:/repo')
    expect(plan.kind).toBe('update')
    expect(plan.previous).toBe('link:/old')
    expect(JSON.parse(plan.nextText).dependencies['dsh-restart']).toBe('link:/repo')
  })

  it('已一致时 skip，且正文原样返回', async () => {
    const install = await loadInstall()
    const text = JSON.stringify({ name: 'p', dependencies: { 'dsh-restart': 'link:/repo' } }, null, 2) + '\n'
    const plan = install.planDependency(text, 'link:/repo')
    expect(plan.kind).toBe('skip')
    expect(plan.nextText).toBe(text)
  })

  it('坏 JSON 直接报错', async () => {
    const install = await loadInstall()
    expect(() => install.planDependency('{ not json', 'link:/repo')).toThrow(/JSON/)
  })
})

describe('cordis patch 幂等追加', () => {
  it('只认 insert 块，顶层同名条目不算已安装', async () => {
    const install = await loadInstall()
    expect(install.hasPatchEntry('- id: restart-button\n  name: dsh-restart\n')).toBe(false)
    expect(install.hasPatchEntry('- insert:\n    - id: restart-button\n      name: dsh-restart\n')).toBe(true)
  })

  it('追加一次后命中，二次不改动', async () => {
    const install = await loadInstall()
    const snippet = await install.readPatchSnippet(repoRoot)
    const original = '- id: web\n  name: dsh-web\n'
    const first = install.appendPatchEntry(original, snippet)
    expect(first.changed).toBe(true)
    expect(first.text.startsWith(original + '\n')).toBe(true)
    expect(install.hasPatchEntry(first.text)).toBe(true)
    const second = install.appendPatchEntry(first.text, snippet)
    expect(second.changed).toBe(false)
    expect(second.text).toBe(first.text)
    expect(first.text.split('id: restart-button')).toHaveLength(2)
  })

  it('空文件可直接追加', async () => {
    const install = await loadInstall()
    const snippet = await install.readPatchSnippet(repoRoot)
    const result = install.appendPatchEntry('', snippet)
    expect(result.changed).toBe(true)
    expect(result.text).toBe(snippet.trimEnd() + '\n')
  })
})

describe('悬空软链', () => {
  it('目标不存在时 remove', async () => {
    const install = await loadInstall()
    const profile = await makeProfile({ dangling: join(await tempDir(), 'gone') })
    const plan = await install.planDanglingLink(profile)
    expect(plan.kind).toBe('remove')
    expect(plan.target).toContain('gone')
  })

  it('目标存在时不动', async () => {
    const install = await loadInstall()
    const target = await tempDir()
    const profile = await makeProfile({ dangling: target })
    const plan = await install.planDanglingLink(profile)
    expect(plan.kind).toBe('none')
    expect(plan.reason).toBe('target-exists')
  })

  it('没有该名字时 none', async () => {
    const install = await loadInstall()
    const plan = await install.planDanglingLink(await makeProfile())
    expect(plan.kind).toBe('none')
    expect(plan.reason).toBe('absent')
  })

  it('同名真实目录不误删', async () => {
    const install = await loadInstall()
    const profile = await makeProfile()
    await mkdir(join(profile, 'node_modules', 'dsh-restart-update'))
    const plan = await install.planDanglingLink(profile)
    expect(plan.kind).toBe('none')
    expect(plan.reason).toBe('not-symlink')
  })
})

describe('仓库产物校验', () => {
  it('产物齐全、dsh.client 声明正确时通过', async () => {
    const install = await loadInstall()
    const report = await install.validateRepo(await makeRepo())
    expect(report.ok).toBe(true)
  })

  it('缺 lib/helper.js 时失败并指出文件', async () => {
    const install = await loadInstall()
    const repo = await makeRepo()
    await rm(join(repo, 'lib', 'helper.js'))
    const report = await install.validateRepo(repo)
    expect(report.ok).toBe(false)
    expect(report.checks.filter((c: any) => !c.ok).map((c: any) => c.name).join(' ')).toContain('lib/helper.js')
  })

  it('package.json 缺 dsh.client 时失败', async () => {
    const install = await loadInstall()
    const repo = await makeRepo()
    await writeFile(join(repo, 'package.json'), JSON.stringify({ name: 'dsh-restart', main: 'lib/index.js' }, null, 2))
    const report = await install.validateRepo(repo)
    expect(report.ok).toBe(false)
  })

  it('产物是 0 字节时失败并指出空文件', async () => {
    const install = await loadInstall()
    const repo = await makeRepo()
    await writeFile(join(repo, 'lib', 'client.js'), '')
    const report = await install.validateRepo(repo)
    expect(report.ok).toBe(false)
    const failed = report.checks.find((check: any) => check.name === '构建产物 lib/client.js')
    expect(failed.detail).toContain('0 bytes')
  })
})

describe('计划与应用', () => {
  it('dry-run 只读：计划列出三类改动且不碰任何文件', async () => {
    const install = await loadInstall()
    const repo = await makeRepo()
    const profile = await makeProfile({ patch: '- id: web\n  name: dsh-web\n', dangling: join(await tempDir(), 'gone') })
    const pkgBefore = await readFile(join(profile, 'package.json'), 'utf8')
    const patchBefore = await readFile(join(profile, 'cordis.patch.yml'), 'utf8')
    const linkPath = join(profile, 'node_modules', 'dsh-restart-update')

    const plan = await install.buildPlan({ repoDir: repo, profileDir: profile })
    expect(plan.validation.ok).toBe(true)
    expect(plan.actions.map((a: any) => a.kind)).toEqual(['dependency:add', 'patch:append', 'link:install', 'link:remove'])
    expect(plan.changed).toBe(true)

    expect(await readFile(join(profile, 'package.json'), 'utf8')).toBe(pkgBefore)
    expect(await readFile(join(profile, 'cordis.patch.yml'), 'utf8')).toBe(patchBefore)
    expect(await linkEntryExists(linkPath)).toBe(true)

    const text = install.formatPlan(plan)
    expect(text).toContain('[dependency:add]')
    expect(text).toContain('[patch:append]')
    expect(text).toContain('[link:install]')
    expect(text).toContain('[link:remove]')
    expect(text).toContain('dry-run')
  })

  it('node_modules/dsh-restart 被真实目录占住时计划 blocked、apply 拒绝', async () => {
    const install = await loadInstall()
    const repo = await makeRepo()
    const profile = await makeProfile()
    await mkdir(join(profile, 'node_modules', 'dsh-restart'))
    const plan = await install.buildPlan({ repoDir: repo, profileDir: profile })
    expect(plan.pluginLink.kind).toBe('blocked')
    expect(plan.changed).toBe(true)
    await expect(install.applyPlan(plan)).rejects.toThrow(/拒绝覆盖/)
    const pkg = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
    expect(pkg.dependencies['dsh-restart']).toBeUndefined()
  })

  it('apply 真写；再次计划全部 skipped 且无字节变化', async () => {
    const install = await loadInstall()
    const repo = await makeRepo()
    const profile = await makeProfile({ patch: '- id: web\n  name: dsh-web\n', dangling: join(await tempDir(), 'gone') })

    const first = await install.buildPlan({ repoDir: repo, profileDir: profile })
    const applied = await install.applyPlan(first)
    expect(applied.changed).toBe(true)

    const pkg = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
    expect(pkg.dependencies['dsh-restart']).toBe('link:' + repo)
    const patch = await readFile(join(profile, 'cordis.patch.yml'), 'utf8')
    expect(patch.split('id: restart-button')).toHaveLength(2)
    expect(existsSync(join(profile, 'node_modules', 'dsh-restart-update'))).toBe(false)
    const pluginLink = await lstat(join(profile, 'node_modules', 'dsh-restart'))
    expect(pluginLink.isSymbolicLink()).toBe(true)
    expect(await realpath(join(profile, 'node_modules', 'dsh-restart'))).toBe(await realpath(repo))

    const pkgAfter = await readFile(join(profile, 'package.json'), 'utf8')
    const patchAfter = await readFile(join(profile, 'cordis.patch.yml'), 'utf8')
    const second = await install.buildPlan({ repoDir: repo, profileDir: profile })
    expect(second.actions.map((a: any) => a.kind)).toEqual(['dependency:skip', 'patch:skip', 'link:keep', 'link:none'])
    expect(second.changed).toBe(false)
    const secondApply = await install.applyPlan(second)
    expect(secondApply.changed).toBe(false)
    expect(await readFile(join(profile, 'package.json'), 'utf8')).toBe(pkgAfter)
    expect(await readFile(join(profile, 'cordis.patch.yml'), 'utf8')).toBe(patchAfter)
  })
})

describe('patch 条目的宽松识别', () => {
  it('同 id 不同 name 视为已安装，但在计划里告警', async () => {
    const install = await loadInstall()
    const repo = await makeRepo()
    const profile = await makeProfile({ patch: '- insert:\n    - id: restart-button\n      name: some-other-plugin\n' })
    const plan = await install.buildPlan({ repoDir: repo, profileDir: profile })
    expect(plan.patch.kind).toBe('patch:skip')
    expect(install.hasPatchEntry('- insert:\n    - id: restart-button\n      name: some-other-plugin\n')).toBe(true)
    expect(plan.warnings.join(' ')).toContain('name 不是 dsh-restart')
  })
})

describe('安装失败态：顺序与自愈提示', () => {
  it('patch 只读：依赖与软链已写、patch 原样、报错说明已完成步骤', async () => {
    const install = await loadInstall()
    const repo = await makeRepo()
    const profile = await makeProfile({ patch: '- id: web\n  name: dsh-web\n' })
    const patchPath = join(profile, 'cordis.patch.yml')
    const patchBefore = await readFile(patchPath, 'utf8')
    await chmod(patchPath, 0o444)
    try {
      const plan = await install.buildPlan({ repoDir: repo, profileDir: profile })
      await expect(install.applyPlan(plan)).rejects.toThrow(/安装中途失败[\s\S]*重跑本脚本即可自愈/)
    } finally {
      await chmod(patchPath, 0o644)
    }
    const pkg = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
    expect(pkg.dependencies['dsh-restart']).toBe('link:' + repo)
    expect(await readFile(patchPath, 'utf8')).toBe(patchBefore)
    expect((await lstat(join(profile, 'node_modules', 'dsh-restart'))).isSymbolicLink()).toBe(true)
  })

  it('node_modules 只读：依赖已写、软链与 patch 都未完成', async () => {
    const install = await loadInstall()
    const repo = await makeRepo()
    const profile = await makeProfile({ patch: '- id: web\n  name: dsh-web\n' })
    const patchPath = join(profile, 'cordis.patch.yml')
    const patchBefore = await readFile(patchPath, 'utf8')
    const modules = join(profile, 'node_modules')
    await chmod(modules, 0o555)
    try {
      const plan = await install.buildPlan({ repoDir: repo, profileDir: profile })
      await expect(install.applyPlan(plan)).rejects.toThrow(/安装中途失败[\s\S]*软链/)
    } finally {
      await chmod(modules, 0o755)
    }
    const pkg = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
    expect(pkg.dependencies['dsh-restart']).toBe('link:' + repo)
    expect(await readFile(patchPath, 'utf8')).toBe(patchBefore)
    expect(await linkEntryExists(join(modules, 'dsh-restart'))).toBe(false)
  })

  it('--apply 文案是「将写入」，不再声称 dry-run 未写文件', async () => {
    const install = await loadInstall()
    const repo = await makeRepo()
    const profile = await makeProfile({ patch: '- id: web\n  name: dsh-web\n' })
    const plan = await install.buildPlan({ repoDir: repo, profileDir: profile })
    const applyText = install.formatPlan(plan, 'apply')
    expect(applyText).toContain('将写入')
    expect(applyText).toContain('patch 最后写')
    expect(applyText).not.toContain('dry-run 未写任何文件')
    const verifyText = install.formatPlan(plan, 'verify')
    expect(verifyText).toContain('只写克隆')
    expect(verifyText).toContain('真实 profile 只读')
  })
})

describe('--verify 纯逻辑', () => {
  it('cloneArgs 在 macOS 用 clonefile，其它平台用普通 -R', async () => {
    const install = await loadInstall()
    expect(install.cloneArgs('/a', '/b', 'darwin')).toEqual(['-c', '-R', '/a', '/b'])
    expect(install.cloneArgs('/a', '/b', 'linux')).toEqual(['-R', '/a', '/b'])
  })

  it('launchArgs 固定 port 0（不碰 3080）且 no-open', async () => {
    const install = await loadInstall()
    expect(install.launchArgs()).toEqual(['--profile', 'web', '--port', '0', '--no-open'])
    expect(install.launchArgs({ profileName: 'dev', port: 1234 })).toEqual(['--profile', 'dev', '--port', '1234', '--no-open'])
  })

  it('清理顺序：先杀进程组，再删临时目录', async () => {
    const install = await loadInstall()
    expect(install.cleanupSequence()).toEqual(['kill-process-group', 'remove-temp-dir'])
    expect(install.VERIFY_DIR_PREFIX).toBe('dsh-restart-verify-')
  })

  it('shouldSyncLockfile：自愈时依赖已 skip 但补写了 patch 也要同步', async () => {
    const install = await loadInstall()
    const plan = (dependencyKind: string, patchChanged: boolean) => ({ dependency: { kind: dependencyKind }, patch: { changed: patchChanged } })
    expect(install.shouldSyncLockfile({ changed: true }, plan('add', false))).toBe(true)
    expect(install.shouldSyncLockfile({ changed: true }, plan('update', false))).toBe(true)
    expect(install.shouldSyncLockfile({ changed: true }, plan('skip', true))).toBe(true)
    expect(install.shouldSyncLockfile({ changed: true }, plan('skip', false))).toBe(false)
    expect(install.shouldSyncLockfile({ changed: false }, plan('add', true))).toBe(false)
  })

  it('syncLockfile 把目录/超时传给 runner 并记录耗时，失败原样带出 reason', async () => {
    const install = await loadInstall()
    const calls: any[] = []
    const ok = install.syncLockfile({
      profileDir: '/tmp/profile',
      run: (dir: string, timeoutMs: number) => {
        calls.push([dir, timeoutMs])
        return { ok: true, output: 'Done' }
      },
    })
    expect(calls).toEqual([['/tmp/profile', 20000]])
    expect(ok.ok).toBe(true)
    expect(typeof ok.elapsedMs).toBe('number')

    const failed = install.syncLockfile({ profileDir: '/tmp/profile', timeoutMs: 500, run: () => ({ ok: false, reason: '超时 500ms' }) })
    expect(failed.ok).toBe(false)
    expect(failed.reason).toBe('超时 500ms')
  })
})

describe('CLI', () => {
  it('默认 dry-run：输出计划、退出 0、不写文件、不动软链', async () => {
    const repo = await makeRepo()
    const profile = await makeProfile({ patch: '- id: web\n  name: dsh-web\n', dangling: join(await tempDir(), 'gone') })
    const pkgBefore = await readFile(join(profile, 'package.json'), 'utf8')
    const linkPath = join(profile, 'node_modules', 'dsh-restart-update')

    const result = spawnSync(process.execPath, [join(repoRoot, 'scripts', 'install.mjs'), '--repo', repo, '--profile', profile], {
      encoding: 'utf8',
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('[dependency:add]')
    expect(result.stdout).toContain('dry-run')
    expect(await readFile(join(profile, 'package.json'), 'utf8')).toBe(pkgBefore)
    expect(await linkEntryExists(linkPath)).toBe(true)
    expect((await lstat(linkPath)).isSymbolicLink()).toBe(true)
  })

  it('未知参数退出 1', async () => {
    const result = spawnSync(process.execPath, [join(repoRoot, 'scripts', 'install.mjs'), '--bogus'], { encoding: 'utf8' })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('未知参数')
  })
})
