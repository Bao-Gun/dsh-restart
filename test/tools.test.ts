import { afterEach, describe, expect, it, vi } from 'vitest'

import { apply } from '../src/index'
import type { RouteContext } from '../src/index'
import { profileOf } from '../src/server/profile'
import { registerTools, toolsOf } from '../src/tools/index'
import type { ToolDefinitionLike, ToolIo } from '../src/tools/index'
import type { PrecheckIo } from '../src/server/precheck'
import type { ScheduleRestartOptions } from '../src/server/restart'

const PROFILE = { dir: '/home/u/.dsh/profiles/web', name: 'web', home: '/home/u/.dsh' }

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
function fakeCtx(options: { tools?: unknown; omitTools?: boolean } = {}): FakeCtx {
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

  it('render 返回文本块，execute 是可调用函数', () => {
    const fake = fakeCtx()
    registerTools(fake.ctx, fakeIo())
    for (const definition of fake.defs) {
      expect(typeof definition.execute).toBe('function')
      const blocks = definition.output.render({}, { summary: '测试摘要' })
      expect(blocks).toEqual([{ type: 'text', text: '测试摘要' }])
    }
  })
})
