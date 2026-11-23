import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { beforeAll, describe, expect, it } from 'vitest'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const clientBundlePath = resolve(repoRoot, 'lib/client.js')
const clientSrcDir = resolve(repoRoot, 'src/client')
const tsupConfigPath = resolve(repoRoot, 'tsup.config.ts')

type Registration = {
  id: string
  factory: (require: (id: string) => unknown) => Record<string, unknown>
}

function newestMtime(dir: string): number {
  return readdirSync(dir, { withFileTypes: true }).reduce((newest, entry) => {
    const full = join(dir, entry.name)
    const mtime = entry.isDirectory() ? newestMtime(full) : statSync(full).mtimeMs
    return Math.max(newest, mtime)
  }, 0)
}

function bundleIsStale(): boolean {
  const bundle = clientBundlePath
  return !existsSync(bundle) || statSync(bundle).mtimeMs <= Math.max(newestMtime(clientSrcDir), statSync(tsupConfigPath).mtimeMs)
}

// 宿主用 document.createElement('script') 以 classic script 加载客户端产物，
// 所以这里必须读真实构建产物，而不是让 Node 的 ESM loader 去 import 它。
//
// 本文件依赖 package.json 的 build 链路（`rm -rf lib && tsup`）。只有产物缺失、
// 或比 src/client 下任一文件 / tsup.config.ts 旧时才现场构建；否则直接读现成产物。
// 不在 beforeAll 里无条件构建，是因为 pnpm test 会改写 lib/：并行跑测试会互删，
// profile 若 link 着本仓库还会 404。改完客户端源码请直接 `pnpm build`。
//
// 注意：下面的 vm 上下文只有 window，没有 document/HTMLElement。Task 7 的模块体
// 一旦在 materialize 时碰 DOM，这里会抛——届时给上下文补最小 stub，或改用 jsdom。
beforeAll(() => {
  if (!bundleIsStale()) return
  execFileSync('pnpm', ['run', 'build'], { cwd: repoRoot, stdio: 'pipe' })
}, 60_000)

describe('lib/client.js 符合宿主 __ModuleLoader__ 契约', () => {
  it('首行自注册，且 id 等于包名', () => {
    const code = readFileSync(clientBundlePath, 'utf8')
    const firstLine = code.split('\n', 1)[0] ?? ''

    expect(firstLine).toContain('__ModuleLoader__.load')
    expect(firstLine).toContain('"dsh-restart"')
  })
})

describe('注册出来的 factory 可被宿主 materialize', () => {
  it('id 正确，materialize 后返回模块导出对象', () => {
    const code = readFileSync(clientBundlePath, 'utf8')
    const holder: { registration: Registration | null } = { registration: null }
    runInNewContext(code, {
      window: {
        __ModuleLoader__: {
          load: (next: Registration) => {
            holder.registration = next
          },
        },
      },
    })

    if (holder.registration === null) {
      throw new Error('lib/client.js 执行后没有向 __ModuleLoader__ 注册')
    }
    const registered = holder.registration
    expect(registered.id).toBe('dsh-restart')
    expect(registered.factory(() => undefined)).toBeTypeOf('object')
  })
})
