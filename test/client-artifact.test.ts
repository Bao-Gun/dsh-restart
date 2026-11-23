import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { beforeAll, describe, expect, it } from 'vitest'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const clientBundlePath = resolve(repoRoot, 'lib/client.js')

type Registration = {
  id: string
  factory: (require: (id: string) => unknown) => Record<string, unknown>
}

// 宿主用 document.createElement('script') 以 classic script 加载客户端产物，
// 所以这里必须读真实构建产物，而不是让 Node 的 ESM loader 去 import 它。
beforeAll(() => {
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