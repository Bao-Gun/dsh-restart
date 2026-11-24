import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const checkIndexUrl = pathToFileURL(join(repoRoot, 'scripts', 'check-index.mjs')).href

/** check-index.mjs 是纯 JS、不参与 tsc；用变量 URL 动态 import，避免 TS7016。 */
async function loadCheckIndex(): Promise<any> {
  return import(checkIndexUrl)
}

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempDir(prefix = 'dsh-restart-index-git-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

/** 临时仓库里不依赖任何全局 git 配置（身份、签名、hooks 都在命令行给）。 */
function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c', 'user.name=t',
      '-c', 'user.email=t@t',
      '-c', 'commit.gpgsign=false',
      '-c', 'init.defaultBranch=main',
      '-c', 'core.hooksPath=.git/no-hooks',
      ...args,
    ],
    { cwd, encoding: 'utf8' },
  ).trim()
}

const ARTIFACTS: Record<string, string> = {
  'lib/index.js': '// built A\n',
  'lib/client.js': '// client\n',
  'lib/helper.js': '// helper\n',
}

/**
 * 造一个两步提交的临时仓库：
 *   first  —— lib/index.js = A（三个产物齐全）
 *   second —— lib/index.js 改一个字节，HEAD 停在 second
 * 所以「与当前提交一致」的只有 second。
 */
async function makeRepo(): Promise<{ dir: string; first: string; second: string }> {
  const dir = await tempDir()
  git(dir, 'init', '-q')
  await mkdir(join(dir, 'lib'), { recursive: true })
  for (const [file, text] of Object.entries(ARTIFACTS)) await writeFile(join(dir, file), text)
  git(dir, 'add', 'lib')
  git(dir, 'commit', '-q', '-m', 'one')
  const first = git(dir, 'rev-parse', 'HEAD')

  await writeFile(join(dir, 'lib/index.js'), '// built B\n')
  git(dir, 'add', 'lib/index.js')
  git(dir, 'commit', '-q', '-m', 'two')
  const second = git(dir, 'rev-parse', 'HEAD')

  return { dir, first, second }
}

async function writeIndexRepo(dir: string, commit: string): Promise<void> {
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'dsh-restart', version: '0.1.0' }, undefined, 2) + '\n',
  )
  await mkdir(join(dir, 'site'), { recursive: true })
  const index = {
    format: 1,
    plugins: [
      {
        name: 'dsh-restart',
        icon: 'icons/dsh-restart.svg',
        versions: [
          {
            version: '0.1.0',
            source: { type: 'git', url: 'https://example.com/dsh-restart.git', commit },
          },
        ],
      },
    ],
  }
  await writeFile(join(dir, 'site', 'index.json'), JSON.stringify(index, undefined, 2) + '\n')
}

describe('commitHasArtifacts（真的问 git，不是桩）', () => {
  it('HEAD 指向的提交里产物齐全 → true', async () => {
    const { commitHasArtifacts } = await loadCheckIndex()
    const { dir, second } = await makeRepo()
    expect(commitHasArtifacts(second, 'lib/index.js', { cwd: dir })).toBe(true)
  })

  it('同路径但内容与当前提交不同（索引指向旧提交）→ false', async () => {
    const { commitHasArtifacts } = await loadCheckIndex()
    const { dir, first } = await makeRepo()
    // 这条钉的就是「删掉 git diff --quiet 那行就变绿」的桩测试抓不到的东西。
    expect(commitHasArtifacts(first, 'lib/index.js', { cwd: dir })).toBe(false)
  })

  it('该提交里根本没有这个产物 → false', async () => {
    const { commitHasArtifacts } = await loadCheckIndex()
    const { dir, second } = await makeRepo()
    expect(commitHasArtifacts(second, 'lib/nope.js', { cwd: dir })).toBe(false)
  })

  it('仓库里没有这个提交（全零）→ false', async () => {
    const { commitHasArtifacts } = await loadCheckIndex()
    const { dir } = await makeRepo()
    expect(commitHasArtifacts('0'.repeat(40), 'lib/index.js', { cwd: dir })).toBe(false)
  })

  it('不是 git 仓库 → false，不抛异常', async () => {
    const { commitHasArtifacts } = await loadCheckIndex()
    const dir = await tempDir('dsh-restart-index-nogit-')
    await mkdir(join(dir, 'lib'), { recursive: true })
    await writeFile(join(dir, 'lib/index.js'), '// built\n')
    expect(commitHasArtifacts('a'.repeat(40), 'lib/index.js', { cwd: dir })).toBe(false)
  })
})

describe('run（整个闸门，临时仓库）', () => {
  it('索引指向当前提交 → 退出 0', async () => {
    const { run } = await loadCheckIndex()
    const { dir, second } = await makeRepo()
    await writeIndexRepo(dir, second)
    const out: string[] = []
    const err: string[] = []
    const code = run({ repoDir: dir, out: (line: string) => out.push(line), err: (line: string) => err.push(line) })
    expect(code).toBe(0)
    expect(out.join('\n')).toContain('索引自检通过')
    expect(err).toEqual([])
  })

  it('索引指向旧提交 → 退出 1，点名 commit 并给发版顺序', async () => {
    const { run } = await loadCheckIndex()
    const { dir, first } = await makeRepo()
    await writeIndexRepo(dir, first)
    const out: string[] = []
    const err: string[] = []
    const code = run({ repoDir: dir, out: (line: string) => out.push(line), err: (line: string) => err.push(line) })
    expect(code).toBe(1)
    expect(out).toEqual([])
    const message = err.join('\n')
    expect(message).toContain(first)
    expect(message).toContain('lib/index.js')
    expect(message).toContain('先 pnpm build 再提交 lib/，再 pnpm market:index')
  })

  it('索引文件读不出来 → 退出 1，点名路径，不给发版指引', async () => {
    const { run } = await loadCheckIndex()
    const { dir } = await makeRepo()
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-restart', version: '0.1.0' }) + '\n')
    const err: string[] = []
    const code = run({ repoDir: dir, out: () => {}, err: (line: string) => err.push(line) })
    expect(code).toBe(1)
    const message = err.join('\n')
    expect(message).toContain(join(dir, 'site', 'index.json'))
    expect(message).not.toContain('pnpm market:index')
  })
})
