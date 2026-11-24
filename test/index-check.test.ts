import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const checkIndexUrl = pathToFileURL(join(repoRoot, 'scripts', 'check-index.mjs')).href

/** check-index.mjs 是纯 JS、不参与 tsc；用变量 URL 动态 import，避免 TS7016。 */
async function loadCheckIndex(): Promise<any> {
  return import(checkIndexUrl)
}

const COMMIT = 'a'.repeat(40)
const ZERO_COMMIT = '0'.repeat(40)
const ICON = 'icons/dsh-restart.svg'

/** 一份最小可用的索引，只留 verifyIndex 会看的字段。 */
function makeIndex(options: { version?: string; commit?: string; icon?: unknown } = {}): any {
  return {
    format: 1,
    title: { en: 'Bao-Gun DSH plugins', zh: '包棍的 DSH 插件' },
    plugins: [
      {
        name: 'dsh-restart',
        icon: options.icon === undefined ? ICON : options.icon,
        versions: [
          {
            version: options.version ?? '0.1.0',
            engines: { dsh: '>=0.2.2-rc.5' },
            source: {
              type: 'git',
              url: 'https://github.com/Bao-Gun/dsh-restart.git',
              commit: options.commit ?? COMMIT,
            },
          },
        ],
      },
    ],
  }
}

function codesOf(result: any): string[] {
  return result.errors.map((error: any) => error.code)
}

describe('verifyIndex', () => {
  it('索引与 package.json 一致、产物齐全时通过', async () => {
    const { verifyIndex } = await loadCheckIndex()
    const result = verifyIndex(makeIndex(), { packageVersion: '0.1.0', commitHasArtifacts: () => true })
    expect(result).toEqual({ ok: true })
  })

  it('版本与 package.json 不一致 → version-mismatch，消息里带两个版本号', async () => {
    const { verifyIndex } = await loadCheckIndex()
    const result = verifyIndex(makeIndex({ version: '0.1.0' }), {
      packageVersion: '0.2.0',
      commitHasArtifacts: () => true,
    })
    expect(result.ok).toBe(false)
    expect(codesOf(result)).toContain('version-mismatch')
    const message = result.errors.find((error: any) => error.code === 'version-mismatch').message
    expect(message).toContain('0.1.0')
    expect(message).toContain('0.2.0')
  })

  it('commit 里没有 lib/client.js → missing-artifacts，消息里带 commit 与新版本号', async () => {
    const { verifyIndex } = await loadCheckIndex()
    const result = verifyIndex(makeIndex({ version: '0.2.0', commit: COMMIT }), {
      packageVersion: '0.2.0',
      commitHasArtifacts: (commit: string, path: string) => !(path === 'lib/client.js' && commit === COMMIT),
    })
    expect(result.ok).toBe(false)
    const error = result.errors.find((item: any) => item.code === 'missing-artifacts')
    expect(error).toBeTruthy()
    expect(error.message).toContain(COMMIT)
    expect(error.message).toContain('0.2.0')
    expect(error.message).toContain('lib/client.js')
  })

  it('commit 是全零（仓库里没有这个提交）→ 同样 missing-artifacts', async () => {
    const { verifyIndex } = await loadCheckIndex()
    const result = verifyIndex(makeIndex({ commit: ZERO_COMMIT }), {
      packageVersion: '0.1.0',
      commitHasArtifacts: (commit: string) => commit !== ZERO_COMMIT,
    })
    expect(result.ok).toBe(false)
    expect(codesOf(result)).toContain('missing-artifacts')
    expect(result.errors[0].message).toContain(ZERO_COMMIT)
  })

  it('版本不对 + 产物缺失同时发生 → 两类错误一次报全（不首错即停）', async () => {
    const { verifyIndex } = await loadCheckIndex()
    const result = verifyIndex(makeIndex({ version: '0.1.0', commit: COMMIT }), {
      packageVersion: '0.2.0',
      commitHasArtifacts: (_commit: string, path: string) => path !== 'lib/index.js',
    })
    expect(result.ok).toBe(false)
    expect(codesOf(result)).toEqual(expect.arrayContaining(['version-mismatch', 'missing-artifacts']))
  })

  it('逐个检查安装器要求的三个产物（少一个就红）', async () => {
    const { verifyIndex } = await loadCheckIndex()
    const seen: string[] = []
    verifyIndex(makeIndex(), {
      packageVersion: '0.1.0',
      commitHasArtifacts: (commit: string, path: string) => {
        expect(commit).toBe(COMMIT)
        seen.push(path)
        return true
      },
    })
    // 三个都钉住：从 REQUIRED_ARTIFACTS 里删掉 lib/helper.js 会让这条红。
    expect([...new Set(seen)].sort()).toEqual(['lib/client.js', 'lib/helper.js', 'lib/index.js'])
  })

  it.each([
    ['含 .. 的相对路径', 'icons/../secret.svg'],
    ['绝对路径', '/etc/passwd.svg'],
    ['Windows 盘符', 'C:/icons/x.svg'],
    ['http 绝对地址（市场只收 https）', 'http://cdn.example.com/dsh-restart.svg'],
  ])('icon 是 %s → invalid-icon', async (_label, icon) => {
    const { verifyIndex } = await loadCheckIndex()
    const result = verifyIndex(makeIndex({ icon }), {
      packageVersion: '0.1.0',
      commitHasArtifacts: () => true,
    })
    expect(result.ok).toBe(false)
    expect(codesOf(result)).toContain('invalid-icon')
    expect(result.errors.find((error: any) => error.code === 'invalid-icon').message).toContain(icon)
  })

  it('跨域 https 图标是市场允许的，不算绝对路径', async () => {
    const { verifyIndex } = await loadCheckIndex()
    const result = verifyIndex(makeIndex({ icon: 'https://cdn.example.com/dsh-restart.svg' }), {
      packageVersion: '0.1.0',
      commitHasArtifacts: () => true,
    })
    expect(result).toEqual({ ok: true })
  })

  it('经软链入口调用时也真的执行（入口判重不能 fail-open）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-restart-index-link-'))
    try {
      const link = join(dir, 'check-index.mjs')
      await symlink(join(repoRoot, 'scripts', 'check-index.mjs'), link)
      const result = spawnSync(process.execPath, [link], { cwd: repoRoot, encoding: 'utf8', timeout: 20000 })
      // 红或绿都算执行过：这里只钉「有输出」，不钉当前索引的状态（Task 4 会把它翻绿）。
      expect(`${result.stdout}${result.stderr}`).toMatch(/\[missing-artifacts\]|索引自检通过/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('没有 plugins 数组 → invalid-index（而不是静默通过）', async () => {
    const { verifyIndex } = await loadCheckIndex()
    const result = verifyIndex({ format: 1 }, { packageVersion: '0.1.0', commitHasArtifacts: () => true })
    expect(result.ok).toBe(false)
    expect(codesOf(result)).toContain('invalid-index')
  })
})
