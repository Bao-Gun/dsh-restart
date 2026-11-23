import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { compatFailures, readInstalled } from '../src/server/compat'
import type { InstalledPlugin } from '../src/server/compat'
import type { Failure } from '../src/shared/types'

/** 本机 dsh 版本；判定本身由宿主做，这里只当输入 */
const RUNTIME = '0.2.2-rc.5'

function plugin(patch: Partial<InstalledPlugin> & { name: string }): InstalledPlugin {
  return { id: patch.name, version: '1.0.0', ...patch }
}

describe('compatFailures', () => {
  it('engines.dsh 要求 >=0.3.0 时，0.2.2-rc.5 报一条带期望值的 compat 失败', () => {
    const failures = compatFailures([plugin({ name: 'x', enginesDsh: '>=0.3.0' })], RUNTIME)

    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({
      kind: 'compat',
      plugin: 'x',
      expected: '>=0.3.0',
      actual: RUNTIME,
    })
  })

  it('engines.dsh 为 * 时不报', () => {
    expect(compatFailures([plugin({ name: 'x', enginesDsh: '*' })], RUNTIME)).toEqual([])
  })

  it('没有 engines.dsh 时按 dsh peer 依赖判', () => {
    const unmet = compatFailures([plugin({ name: 'x', peerDsh: '>=0.3.0' })], RUNTIME)
    expect(unmet).toHaveLength(1)
    // peer 失败要带上包名，多 peer 时才知道是哪一条
    expect(unmet[0]).toMatchObject({ kind: 'compat', plugin: 'x', expected: '@deepseek-ai/dsh >=0.3.0' })

    expect(compatFailures([plugin({ name: 'x', peerDsh: '>=0.2.0' })], RUNTIME)).toEqual([])
  })

  it('engines.dsh 存在时独占判定，peer 不再参与', () => {
    const failures = compatFailures(
      [plugin({ name: 'x', enginesDsh: '*', peerDsh: '>=0.3.0' })],
      RUNTIME,
    )

    expect(failures).toEqual([])
  })

  it('取不到运行时版本时返回明确失败，绝不静默判兼容', () => {
    for (const bad of ['', '   ', 'not-a-version']) {
      const failures = compatFailures([plugin({ name: 'x', enginesDsh: '*' })], bad)

      expect(failures).toHaveLength(1)
      expect(failures[0]?.kind).toBe('compat')
      expect(failures[0]?.message).toContain('版本')
    }
  })

  it('宿主包解析不到时返回明确失败，且不把负结果永久缓存', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-restart-host-'))
    const saved = process.env.DSH_RESTART_DSH_DIR
    try {
      // 看起来像 dsh 安装根，但 app-boot 的入口文件故意不建 —— 加载必失败
      await mkdir(join(root, 'node_modules', '@deepseek-ai', 'dsh-app-boot'), { recursive: true })
      await writeFile(
        join(root, 'package.json'),
        JSON.stringify({ name: '@deepseek-ai/dsh', version: RUNTIME }),
        'utf8',
      )
      await writeFile(
        join(root, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'package.json'),
        JSON.stringify({ name: '@deepseek-ai/dsh-app-boot', version: RUNTIME, main: 'lib/index.js' }),
        'utf8',
      )

      process.env.DSH_RESTART_DSH_DIR = root
      vi.resetModules()
      const fresh = await import('../src/server/compat')

      // 连打两次：第二次仍要重试并报失败，不能因为第一次失败就永久判「兼容」
      for (let round = 0; round < 2; round += 1) {
        const failures = fresh.compatFailures([plugin({ name: 'x', enginesDsh: '*' })], RUNTIME)
        expect(failures).toHaveLength(1)
        expect(failures[0]?.kind).toBe('compat')
        expect(failures[0]?.message).toContain('DSH_RESTART_DSH_DIR')
        expect(failures[0]?.message).toContain(root)
      }
    } finally {
      if (saved === undefined) delete process.env.DSH_RESTART_DSH_DIR
      else process.env.DSH_RESTART_DSH_DIR = saved
      vi.resetModules()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('单个插件清单坏掉不中断整轮，其它插件照判', () => {
    const failures = compatFailures(
      [
        plugin({ name: 'bad', version: '', enginesDsh: '>=0.3.0' }),
        plugin({ name: 'x', enginesDsh: '>=0.3.0' }),
      ],
      RUNTIME,
    )

    expect(failures).toHaveLength(2)
    expect(failures.map((failure) => failure.plugin)).toContain('x')
    expect(failures.find((failure) => failure.plugin === 'bad')?.message).toContain('version')
  })
})

describe('readInstalled', () => {
  let dir = ''

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-restart-compat-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function writeJson(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(value), 'utf8')
  }

  /** 两个正常依赖（engines / peer 各一）、一个坏清单、一个只在 patch 里出现的插件。 */
  async function seedProfile(): Promise<void> {
    await writeJson(join(dir, 'package.json'), {
      name: 'dsh-profile-test',
      dependencies: { a: '1.0.0', b: '2.0.0', broken: '1.0.0' },
    })
    await writeJson(join(dir, 'node_modules', 'a', 'package.json'), {
      name: 'a',
      version: '1.2.3',
      engines: { dsh: '>=0.3.0' },
    })
    await writeJson(join(dir, 'node_modules', 'b', 'package.json'), {
      name: 'b',
      version: '2.0.0',
      peerDependencies: { '@deepseek-ai/dsh': '>=0.2.0', '@deepseek-ai/dsh-tools': '>=0.3.0' },
    })
    await mkdir(join(dir, 'node_modules', 'broken'), { recursive: true })
    await writeFile(join(dir, 'node_modules', 'broken', 'package.json'), '{ 半截', 'utf8')
    await writeJson(join(dir, 'node_modules', 'c', 'package.json'), {
      name: 'c',
      version: '0.1.0',
      engines: { dsh: '*' },
    })
    await writeFile(
      join(dir, 'cordis.patch.yml'),
      [
        '- id: a-row',
        '  name: a',
        '- id: c-row',
        '  name: "c"',
        '- id: host-row',
        '  name: "@deepseek-ai/dsh-web"',
        '- id: model-row',
        '  name: "GLM-5"',
        '- id: model-row-long',
        '  name: "DeepSeek V4 Pro · Bailian Token Plan"',
      ].join('\n'),
      'utf8',
    )
  }

  it('读依赖与 patch 条目，带出 engines/peer，坏清单记 warning 不抛', async () => {
    await seedProfile()
    const warnings: Failure[] = []

    const plugins = await readInstalled(dir, { onWarning: (failure) => warnings.push(failure) })

    expect(plugins.map((item) => item.name).sort()).toEqual(['a', 'b', 'c'])
    expect(plugins.find((item) => item.name === 'a')).toMatchObject({
      id: 'a',
      version: '1.2.3',
      enginesDsh: '>=0.3.0',
    })
    const b = plugins.find((item) => item.name === 'b')
    expect(b?.peerDsh).toBe('>=0.2.0')
    expect(b?.peerDependencies?.['@deepseek-ai/dsh-tools']).toBe('>=0.3.0')
    // 依赖里没有、只在 patch 里挂的插件也读得到，id 用 patch 的条目 id
    expect(plugins.find((item) => item.name === 'c')?.id).toBe('c-row')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatchObject({ kind: 'compat', plugin: 'broken' })
  })

  it('读出来的插件直接喂给判定：engines 与 dsh-* peer 都会被点名', async () => {
    await seedProfile()

    const failures = compatFailures(await readInstalled(dir), RUNTIME)

    expect(failures.map((failure) => failure.plugin).sort()).toEqual(['a', 'b'])
  })

  it('清单里的 engines / peerDependencies 形状不对时报明确失败，不静默判兼容', async () => {
    await writeJson(join(dir, 'package.json'), { name: 'p', dependencies: { bad: '1.0.0' } })
    await writeJson(join(dir, 'node_modules', 'bad', 'package.json'), {
      name: 'bad',
      version: '1.0.0',
      // 宿主对这两种形状都会抛错并停用插件
      engines: '>=0.2.0',
      peerDependencies: { '@deepseek-ai/dsh': 1 },
    })

    const plugins = await readInstalled(dir)
    expect(plugins[0]?.manifestProblems?.map((problem) => problem.field)).toEqual([
      'engines',
      'peerDependencies["@deepseek-ai/dsh"]',
    ])

    const failures = compatFailures(plugins, RUNTIME)
    expect(failures).toHaveLength(2)
    expect(failures.map((failure) => failure.expected)).toEqual([
      'engines 为 对象',
      'peerDependencies["@deepseek-ai/dsh"] 为 版本范围字符串',
    ])
    for (const failure of failures) expect(failure.message).toContain('停用')
  })

  it('patch 条目 id 带行尾注释也能认', async () => {
    await writeJson(join(dir, 'package.json'), { name: 'p' })
    await writeJson(join(dir, 'node_modules', 'commented', 'package.json'), {
      name: 'commented',
      version: '1.0.0',
    })
    await writeFile(
      join(dir, 'cordis.patch.yml'),
      ['- id: commented-row # 本地插件', '  name: "commented" # 备注'].join('\n'),
      'utf8',
    )

    const plugins = await readInstalled(dir)
    expect(plugins).toHaveLength(1)
    expect(plugins[0]?.id).toBe('commented-row')
  })

  it('patch 只挂的第三方条目装不上时给 warning，官方内置包保持安静', async () => {
    await writeJson(join(dir, 'package.json'), { name: 'p' })
    await writeFile(
      join(dir, 'cordis.patch.yml'),
      ['- id: ghost-row', '  name: ghost-plugin', '- id: host-row', '  name: "@deepseek-ai/dsh-web"'].join('\n'),
      'utf8',
    )
    const warnings: Failure[] = []

    const plugins = await readInstalled(dir, { onWarning: (failure) => warnings.push(failure) })

    expect(plugins).toEqual([])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatchObject({ kind: 'compat', plugin: 'ghost-plugin' })
    expect(warnings[0]?.message).toContain('ghost-row')
  })

  it('profile 的 package.json 坏掉时给 warning；文件不存在时安静返回空列表', async () => {
    await expect(readInstalled(dir)).resolves.toEqual([])

    await writeFile(join(dir, 'package.json'), '{ 半截', 'utf8')
    const warnings: Failure[] = []
    await expect(readInstalled(dir, { onWarning: (failure) => warnings.push(failure) })).resolves.toEqual([])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatchObject({ kind: 'compat', plugin: 'profile' })
  })
})
