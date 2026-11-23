import { afterEach, describe, expect, it, vi } from 'vitest'

import { apply } from '../src/index'
import type { RouteContext } from '../src/index'
import { profileOf } from '../src/server/profile'
import { registerTools, toolsOf } from '../src/tools/index'
import type { ToolDefinitionLike, ToolIo } from '../src/tools/index'
import { acquirePrecheck, releasePrecheck } from '../src/server/precheck'
import type { PrecheckIo } from '../src/server/precheck'
import type { ScheduleRestartOptions } from '../src/server/restart'
import type { Failure, LastRecord } from '../src/shared/types'

const PROFILE = { dir: '/home/u/.dsh/profiles/web', name: 'web', home: '/home/u/.dsh' }

/** 预检工具的输出契约（Task 4 brief 的 11 个字段，一个不多一个不少）。 */
interface PrecheckValue {
  ok: boolean
  busy: boolean
  cancelled: boolean
  saved: boolean
  durationMs: number
  health: boolean
  failures: Failure[]
  warnings: Failure[]
  entries: string[]
  fingerprint: string
  summary: string
}

/** 假 io：预检字段全绿，重启字段可断言副作用。 */
function fakeIo(overrides: Partial<ToolIo> = {}): ToolIo {
  const scheduled: ScheduleRestartOptions[] = []
  const base: PrecheckIo & { isRefused(lockPath: string): Promise<boolean>; scheduleRestart(o: ScheduleRestartOptions): void } = {
    now: () => new Date('2026-11-23T12:00:00.000Z'),
    readLast: async () => ({}),
    writeLast: async () => {},
    computeFingerprint: async () => '0123456789abcdef',
    runtimeVersion: () => '0.2.2-rc.5',
    runDumpConfig: async () => [],
    readInstalled: async () => [],
    compatFailures: () => [],
    runSmoke: async () => ({ ok: true, health: true, failures: [], failedEntries: [], durationMs: 1 }),
    tmpRoot: '/tmp/dsh-restart-test/tmp',
    logDir: '/tmp/dsh-restart-test/log',
    isRefused: async () => false,
    scheduleRestart: (options) => {
      scheduled.push(options)
    },
  }
  return { ...base, ...overrides }
}

interface ToolCtxLike {
  get(service: string): unknown
  effect(callback: () => void | (() => void), label?: string): void
}

interface FakeCtx {
  ctx: ToolCtxLike
  defs: ToolDefinitionLike[]
  labels: string[]
  disposers: Array<() => void>
  live: ToolDefinitionLike[]
}

/**
 * 假宿主上下文：tools 注册表把定义收进 defs/live。
 * Proxy 模拟 cordis 的注入规则——访问 ctx.tools 属性直接抛，确保实现只走 ctx.get('tools')。
 */
function fakeCtx(options: { tools?: unknown; omitTools?: boolean; profile?: unknown } = {}): FakeCtx {
  const defs: ToolDefinitionLike[] = []
  const live: ToolDefinitionLike[] = []
  const labels: string[] = []
  const disposers: Array<() => void> = []
  const registry = {
    register(definition: ToolDefinitionLike) {
      defs.push(definition)
      live.push(definition)
      return () => {
        const index = live.indexOf(definition)
        if (index >= 0) live.splice(index, 1)
      }
    },
  }
  const services: Record<string, unknown> = {}
  if (options.omitTools !== true) services.tools = options.tools ?? registry
  if (options.profile !== undefined) services.profileContext = options.profile
  const target = {
    effect(callback: () => void | (() => void), label?: string) {
      labels.push(label ?? '')
      const dispose = callback()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    get(service: string): unknown {
      return services[service]
    },
  }
  const ctx = new Proxy(target, {
    get(object, property, receiver) {
      if (property === 'tools') throw new Error('cannot get property "tools" without inject')
      return Reflect.get(object, property, receiver)
    },
  })
  return { ctx, defs, labels, disposers, live }
}

/** 递归找出不能进 JSON 的值：undefined、函数、非有限数，以及非普通对象。 */
function jsonProblems(value: unknown, path = 'value'): string[] {
  if (value === undefined) return [path + ' 是 undefined']
  if (typeof value === 'function') return [path + ' 是函数']
  if (typeof value === 'number' && !Number.isFinite(value)) return [path + ' 不是有限数']
  if (typeof value === 'bigint' || typeof value === 'symbol') return [path + ' 不是 JSON 值']
  if (Array.isArray(value)) return value.flatMap((item, index) => jsonProblems(item, path + '[' + index + ']'))
  if (value !== null && typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return [path + ' 不是普通对象']
    return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => jsonProblems(item, path + '.' + key))
  }
  return []
}

afterEach(() => {
  vi.restoreAllMocks()
  // 互斥是模块级的；用例之间别把锁漏给别人。
  releasePrecheck()
})

describe('profileOf', () => {
  it('从 profileContext 取 dir / name / home', () => {
    expect(profileOf({ get: () => PROFILE })).toEqual(PROFILE)
  })

  it('name / home 缺省时从 dir 推导', () => {
    const profile = { dir: '/home/u/.dsh/profiles/web' }
    expect(profileOf({ get: () => profile })).toEqual({
      dir: '/home/u/.dsh/profiles/web',
      name: 'web',
      home: '/home/u/.dsh',
    })
    expect(profileOf({ get: () => ({ dir: '/home/u/.dsh/profiles/web', name: '', home: '' }) })).toEqual({
      dir: '/home/u/.dsh/profiles/web',
      name: 'web',
      home: '/home/u/.dsh',
    })
  })

  it('dir 缺失、空白或不是字符串时返回 undefined', () => {
    expect(profileOf({ get: () => ({}) })).toBeUndefined()
    expect(profileOf({ get: () => ({ dir: '   ' }) })).toBeUndefined()
    expect(profileOf({ get: () => ({ dir: 42 }) })).toBeUndefined()
  })

  it('get 抛错或返回非对象时返回 undefined', () => {
    expect(
      profileOf({
        get: () => {
          throw new Error('cannot get property "profileContext" without inject')
        },
      }),
    ).toBeUndefined()
    expect(profileOf({ get: () => undefined })).toBeUndefined()
    expect(profileOf({ get: () => [] })).toBeUndefined()
    expect(profileOf({ get: () => 'nope' })).toBeUndefined()
  })
})

describe('toolsOf', () => {
  it('只走 ctx.get("tools")，拿到带 register 的注册表', () => {
    const fake = fakeCtx()
    const tools = toolsOf(fake.ctx)
    expect(tools).toBeDefined()
    expect(typeof tools?.register).toBe('function')
  })

  it('没有 tools 服务时返回 undefined', () => {
    expect(toolsOf(fakeCtx({ omitTools: true }).ctx)).toBeUndefined()
  })

  it('服务形状不对（非对象 / 没有 register）时返回 undefined', () => {
    expect(toolsOf(fakeCtx({ tools: 'nope' }).ctx)).toBeUndefined()
    expect(toolsOf(fakeCtx({ tools: {} }).ctx)).toBeUndefined()
    expect(toolsOf(fakeCtx({ tools: { register: 1 } }).ctx)).toBeUndefined()
  })

  it('get 抛错时返回 undefined，不向上抛', () => {
    const ctx = {
      get(): unknown {
        throw new Error('cannot get property "tools" without inject')
      },
    }
    expect(toolsOf(ctx)).toBeUndefined()
  })
})

describe('registerTools', () => {
  it('注册两个工具，名字与参数 schema 固定', () => {
    const fake = fakeCtx()
    const count = registerTools(fake.ctx, fakeIo())

    expect(count).toBe(2)
    expect(fake.defs.map((definition) => definition.name)).toEqual(['dsh_restart_precheck', 'dsh_restart'])
    expect(fake.defs[0]?.parameters).toEqual({ type: 'object', properties: {}, additionalProperties: false })
    const restartParameters = fake.defs[1]?.parameters as { properties: Record<string, unknown> }
    expect(restartParameters.properties.force).toMatchObject({ type: 'boolean' })
  })

  it('每个工具都用 ctx.effect 包住注册，标签带工具名', () => {
    const fake = fakeCtx()
    registerTools(fake.ctx, fakeIo())
    expect(fake.labels).toEqual(['dsh-restart: dsh_restart_precheck', 'dsh-restart: dsh_restart'])
    expect(fake.live.map((definition) => definition.name)).toEqual(['dsh_restart_precheck', 'dsh_restart'])
  })

  it('effect 的 disposer 会反注册', () => {
    const fake = fakeCtx()
    registerTools(fake.ctx, fakeIo())
    expect(fake.disposers).toHaveLength(2)
    fake.disposers[0]?.()
    expect(fake.live.map((definition) => definition.name)).toEqual(['dsh_restart'])
  })

  it('没有 tools 服务时不抛，返回 0 并只打一条日志', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fake = fakeCtx({ omitTools: true })
    expect(registerTools(fake.ctx, fakeIo())).toBe(0)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(fake.labels).toHaveLength(0)
  })

  it('输出 schema / 参数 schema 都是干净 JSON 值，根节点禁止额外字段', () => {
    const fake = fakeCtx()
    registerTools(fake.ctx, fakeIo())
    for (const definition of fake.defs) {
      expect(jsonProblems(definition.parameters)).toEqual([])
      expect(jsonProblems(definition.output.schema)).toEqual([])
      expect(definition.output.schema).toMatchObject({ type: 'object', additionalProperties: false })
      const schema = definition.output.schema as { properties: Record<string, unknown>; required: string[] }
      // required 里的字段必须真的在 properties 里声明，别让宿主校验时永远过不去。
      expect(schema.required.length).toBeGreaterThan(0)
      for (const field of schema.required) expect(schema.properties).toHaveProperty(field)
    }
  })

  it('apply 在有 tools 服务时把两个工具一起注册（共享同一份 io 的接线点）', () => {
    const defs: ToolDefinitionLike[] = []
    const labels: string[] = []
    const routes: string[] = []
    const ctx = {
      webServer: {
        port: 3080,
        register(route: { path: string }) {
          routes.push(route.path)
          return () => {}
        },
      },
      effect(callback: () => void | (() => void), label?: string) {
        labels.push(label ?? '')
        callback()
      },
      get(service: string): unknown {
        if (service === 'tools') {
          return {
            register(definition: ToolDefinitionLike) {
              defs.push(definition)
              return () => {}
            },
          }
        }
        return undefined
      },
    }
    apply(ctx as unknown as RouteContext)

    expect(routes).toHaveLength(3)
    expect(defs.map((definition) => definition.name)).toEqual(['dsh_restart_precheck', 'dsh_restart'])
    expect(labels).toHaveLength(5)
    expect(labels.slice(3)).toEqual(['dsh-restart: dsh_restart_precheck', 'dsh-restart: dsh_restart'])
  })

  it('render 返回文本块：首个文本块是 summary，预检再把 failures/warnings 逐行附上', () => {
    const fake = fakeCtx()
    registerTools(fake.ctx, fakeIo())
    for (const definition of fake.defs) {
      expect(typeof definition.execute).toBe('function')
    }
    const precheckDefinition = fake.defs.find((definition) => definition.name === 'dsh_restart_precheck') as ToolDefinitionLike
    const restartDefinition = fake.defs.find((definition) => definition.name === 'dsh_restart') as ToolDefinitionLike

    // 重启工具本轮不动：仍然只回一行 summary。
    expect(restartDefinition.output.render({}, { summary: '测试摘要' })).toEqual([{ type: 'text', text: '测试摘要' }])

    const blocks = precheckDefinition.output.render(
      {},
      {
        summary: '检查没通过：试跑实例没起来',
        failures: [{ kind: 'boot', message: '试跑实例没起来', plugin: 'dsh-broken' }],
        warnings: [{ kind: 'compat', message: '版本不符' }],
      },
    )
    expect(blocks[0]).toEqual({ type: 'text', text: '检查没通过：试跑实例没起来' })
    expect(blocks).toHaveLength(3)
    expect(blocks[1]?.text).toContain('试跑实例没起来')
    expect(blocks[2]?.text).toContain('版本不符')
  })
})
describe('dsh_restart_precheck', () => {
  /** 取出预检工具定义；默认给 profileContext 指到 PROFILE。 */
  function precheckOf(io: ToolIo, options: { omitProfile?: boolean } = {}): ToolDefinitionLike {
    const fake = fakeCtx(options.omitProfile === true ? {} : { profile: PROFILE })
    registerTools(fake.ctx, io)
    const definition = fake.defs.find((item) => item.name === 'dsh_restart_precheck')
    if (definition === undefined) throw new Error('dsh_restart_precheck 没有注册')
    return definition
  }

  async function runPrecheck(io: ToolIo, exec: { signal?: AbortSignal } = {}): Promise<PrecheckValue> {
    return (await precheckOf(io).execute({}, exec)) as PrecheckValue
  }

  /** execute 返回后必须放锁：漏放会让之后的预检永久 busy，只能重启宿主。 */
  function expectReleased(): void {
    expect(acquirePrecheck()).toBe(true)
    releasePrecheck()
  }

  it('通过时 ok:true、summary 含「通过」，并写一次 precheck', async () => {
    const written: Array<Partial<LastRecord>> = []
    const value = await runPrecheck(
      fakeIo({
        writeLast: async (_dir, patch) => {
          written.push(patch)
        },
      }),
    )

    expect(value.ok).toBe(true)
    expect(value.busy).toBe(false)
    expect(value.cancelled).toBe(false)
    expect(value.saved).toBe(true)
    expect(value.health).toBe(true)
    expect(value.fingerprint).toBe('0123456789abcdef')
    expect(value.failures).toEqual([])
    expect(value.warnings).toEqual([])
    expect(value.entries).toEqual([])
    expect(value.durationMs).toBeGreaterThanOrEqual(0)
    expect(value.summary).toContain('通过')
    expect(written).toHaveLength(1)
    expect(written[0]?.precheck).toMatchObject({ ok: true, fingerprint: '0123456789abcdef' })
    expectReleased()
    expect(jsonProblems(value)).toEqual([])
  })

  it('判红时 ok:false 但不抛错，failures 原样带回', async () => {
    const failures: Failure[] = [{ kind: 'boot', message: '试跑实例没起来', plugin: 'dsh-broken' }]
    const value = await runPrecheck(
      fakeIo({
        runSmoke: async () => ({ ok: false, health: false, failures, failedEntries: [], durationMs: 1 }),
      }),
    )

    expect(value.ok).toBe(false)
    expect(value.busy).toBe(false)
    expect(value.cancelled).toBe(false)
    expect(value.failures).toEqual(failures)
    expect(value.summary).toBe('检查没通过：试跑实例没起来')
    expectReleased()
    expect(jsonProblems(value)).toEqual([])
  })

  it('已有一轮预检时返回 busy:true，不跑冒烟也不释放别人的锁', async () => {
    releasePrecheck()
    expect(acquirePrecheck()).toBe(true)
    let smoked = 0
    const value = await runPrecheck(
      fakeIo({
        runSmoke: async () => {
          smoked += 1
          return { ok: true, health: true, failures: [], failedEntries: [], durationMs: 1 }
        },
      }),
    )

    expect(value).toMatchObject({ ok: false, busy: true, cancelled: false, saved: false, durationMs: 0, health: false })
    expect(value.failures).toEqual([])
    expect(value.warnings).toEqual([])
    expect(value.entries).toEqual([])
    expect(value.fingerprint).toBe('')
    expect(value.summary).toContain('预检')
    expect(smoked).toBe(0)
    // 锁在别人手里，工具没拿到就不许替别人 release。
    expect(acquirePrecheck()).toBe(false)
    expect(jsonProblems(value)).toEqual([])
  })

  it('signal 中断返回 cancelled:true 且不写盘', async () => {
    const controller = new AbortController()
    let writes = 0
    const value = await runPrecheck(
      fakeIo({
        // 取消发生在 boot 之前：兼容性阶段一返回就把 signal 打断。
        readInstalled: async () => {
          controller.abort()
          return []
        },
        writeLast: async () => {
          writes += 1
        },
      }),
      { signal: controller.signal },
    )

    expect(value.cancelled).toBe(true)
    expect(value.ok).toBe(false)
    expect(value.saved).toBe(false)
    expect(value.health).toBe(false)
    expect(value.summary).toBe('这轮预检被取消，不作数')
    expect(writes).toBe(0)
    expectReleased()
    expect(jsonProblems(value)).toEqual([])
  })

  it('没有 profileContext 时 ok:false，summary 说明原因', async () => {
    let smoked = 0
    const definition = precheckOf(
      fakeIo({
        runSmoke: async () => {
          smoked += 1
          return { ok: true, health: true, failures: [], failedEntries: [], durationMs: 1 }
        },
      }),
      { omitProfile: true },
    )
    const value = (await definition.execute({}, {})) as PrecheckValue

    expect(value).toMatchObject({ ok: false, busy: false, cancelled: false, saved: false, durationMs: 0, health: false })
    expect(value.summary).toContain('profileContext')
    expect(smoked).toBe(0)
    expect(jsonProblems(value)).toEqual([])
  })

  it('写盘失败时 ok 保持，saved:false，summary 承载 error 文案', async () => {
    const value = await runPrecheck(
      fakeIo({
        writeLast: async () => {
          throw new Error('disk full')
        },
      }),
    )

    expect(value.ok).toBe(true)
    expect(value.saved).toBe(false)
    expect(value.summary).toContain('disk full')
    expectReleased()
    expect(jsonProblems(value)).toEqual([])
  })

  it('判红且写盘失败时，summary 同时带回第一条 failure 与 error', async () => {
    const failures: Failure[] = [{ kind: 'boot', message: '试跑实例没起来', plugin: 'dsh-broken' }]
    const value = await runPrecheck(
      fakeIo({
        runSmoke: async () => ({ ok: false, health: false, failures, failedEntries: [], durationMs: 1 }),
        writeLast: async () => {
          throw new Error('disk full')
        },
      }),
    )

    expect(value.ok).toBe(false)
    expect(value.saved).toBe(false)
    expect(value.failures).toEqual(failures)
    // 工具值没有 error 字段，写盘失败这件事只能靠 summary 交代。
    expect(value.summary).toContain('检查没通过：试跑实例没起来')
    expect(value.summary).toContain('disk full')
    expectReleased()
    expect(jsonProblems(value)).toEqual([])
  })
})

