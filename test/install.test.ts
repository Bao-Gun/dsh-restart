import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
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
    expect(text).toContain('[add]')
    expect(text).toContain('[append]')
    expect(text).toContain('[install]')
    expect(text).toContain('[remove]')
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
    expect(result.stdout).toContain('[add]')
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
