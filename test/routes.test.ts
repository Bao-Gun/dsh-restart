import type { IncomingMessage, ServerResponse } from 'node:http'

import { describe, expect, it } from 'vitest'

import {
  Config,
  PRECHECK_PATH,
  RESTART_PATH,
  STATUS_PATH,
  apply,
  createHandlers,
  inject,
  isAllowed,
  name,
} from '../src/index'
import type { RouteContext, RouteHandler, RouteIo } from '../src/index'
import type { Failure, LastRecord } from '../src/shared/types'
import type { SmokeResult } from '../src/server/smoke'

const PROFILE = { dir: '/home/u/.dsh/profiles/web', name: 'web', home: '/home/u/.dsh' }
const FP = '0123456789abcdef'

interface FakeRes {
  statusCode: number
  headersSent: boolean
  writableEnded: boolean
  headers: Record<string, string>
  chunks: string[]
  setHeader(name: string, value: string): void
  flushHeaders(): void
  write(chunk: string): boolean
  end(chunk?: string): void
  once(event: 'finish' | 'close', listener: () => void): void
  emit(event: 'finish' | 'close'): void
}

/**
 * 假响应：只记录写出去的东西，不碰 socket。
 * end() 同步触发 finish 再触发 close，等价于真实响应「已冲刷并关闭」。
 * emit('close') 用来模拟客户端在流中途断开。listener 按 once 语义只留到第一次 emit。
 */
function makeRes(options: { suppressFinish?: boolean } = {}): FakeRes {
  const listeners: Record<'finish' | 'close', Array<() => void>> = { finish: [], close: [] }
  const res: FakeRes = {
    statusCode: 200,
    headersSent: false,
    writableEnded: false,
    headers: {},
    chunks: [],
    setHeader(header, value) {
      res.headers[header.toLowerCase()] = value
    },
    flushHeaders() {
      res.headersSent = true
    },
    write(chunk) {
      res.chunks.push(String(chunk))
      return true
    },
    end(chunk) {
      if (chunk !== undefined) res.chunks.push(String(chunk))
      res.headersSent = true
      res.writableEnded = true
      if (options.suppressFinish !== true) res.emit('finish')
      res.emit('close')
    },
    once(event, listener) {
      listeners[event].push(listener)
    },
    emit(event) {
      const pending = listeners[event]
      listeners[event] = []
      for (const listener of pending) listener()
    },
  }
  return res
}

function makeReq(
  options: { method?: string; headers?: Record<string, string>; url?: string; remoteAddress?: string } = {},
): IncomingMessage {
  return {
    method: options.method ?? 'GET',
    headers: { host: '127.0.0.1:3080', 'x-dsh-restart': '1', ...options.headers },
    url: options.url ?? STATUS_PATH,
    socket: { remoteAddress: options.remoteAddress ?? '127.0.0.1' },
  } as unknown as IncomingMessage
}

interface FakeCtx {
  ctx: RouteContext
  routes: Map<string, { kind: string; path: string; handler: RouteHandler }>
  labels: string[]
}

function makeCtx(
  options: {
    port?: number
    omitPort?: boolean
    profile?: { dir: string; name: string; home: string } | undefined
    rejection?: number | ((req: IncomingMessage) => number | undefined)
    omitConnection?: boolean
  } = {},
): FakeCtx {
  const routes = new Map<string, { kind: string; path: string; handler: RouteHandler }>()
  const labels: string[] = []
  const rejection = options.rejection ?? (() => undefined)
  const connection = {
    requestRejection: typeof rejection === 'function' ? rejection : () => rejection,
  }
  const ctx = {
    ...(options.omitConnection === true ? {} : { connection }),
    webServer: {
      port: options.omitPort === true ? undefined : (options.port ?? 3080),
      register(route: { kind: string; path: string; handler: RouteHandler }) {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
    effect(callback: () => void | (() => void), label?: string) {
      labels.push(label ?? '')
      callback()
    },
    get(service: string): unknown {
      if (service === 'profileContext') return options.profile
      if (service === 'connection') return options.omitConnection === true ? undefined : connection
      return undefined
    },
  }
  return { ctx: ctx as unknown as RouteContext, routes, labels }
}

function makeIo(overrides: Partial<RouteIo> = {}): { io: RouteIo } {
  const io: RouteIo = {
    now: () => new Date('2026-11-23T12:00:00.000Z'),
    readLast: async () => ({}),
    writeLast: async () => {},
    computeFingerprint: async () => FP,
    runtimeVersion: () => '0.2.2-rc.5',
    probeHealth: async () => true,
    runDumpConfig: async () => [],
    readInstalled: async () => [],
    compatFailures: () => [],
    runSmoke: async () => ({ ok: true, health: true, failures: [], failedEntries: [], durationMs: 1 }),
    scheduleRestart: () => {},
    isRefused: async () => false,
    tmpRoot: '/tmp/dsh-restart-test/tmp',
    logDir: '/tmp/dsh-restart-test/log',
    ...overrides,
  }
  return { io }
}

async function call(handler: RouteHandler, req: IncomingMessage, res: FakeRes): Promise<FakeRes> {
  await handler(req, res as unknown as ServerResponse)
  return res
}

function json(res: FakeRes): Record<string, unknown> {
  return JSON.parse(res.chunks.join('')) as Record<string, unknown>
}

function ndjson(res: FakeRes): Array<Record<string, unknown>> {
  return res.chunks
    .filter((chunk) => chunk.trim() !== '')
    .map((chunk) => JSON.parse(chunk) as Record<string, unknown>)
}

function smoke(overrides: Partial<SmokeResult> = {}): SmokeResult {
  return { ok: true, health: true, failures: [], failedEntries: [], durationMs: 1, ...overrides }
}

describe('isAllowed：请求门', () => {
  it('rejection=403 时拒绝', () => {
    expect(isAllowed({ method: 'POST', headers: { 'x-dsh-restart': '1' }, rejection: 403 })).toBe(false)
  })

  it('没有 x-dsh-restart 头时拒绝', () => {
    expect(isAllowed({ method: 'POST', headers: {} })).toBe(false)
    expect(isAllowed({ method: 'GET', headers: { 'x-dsh-restart': '0' } })).toBe(false)
  })

  it('GET / POST + 头 + 无 rejection 才放行', () => {
    expect(isAllowed({ method: 'GET', headers: { 'x-dsh-restart': '1' } })).toBe(true)
    expect(isAllowed({ method: 'POST', headers: { 'x-dsh-restart': '1' } })).toBe(true)
  })

  it('头名大小写不敏感；方法只认 GET/POST', () => {
    expect(isAllowed({ method: 'post', headers: { 'X-DSH-Restart': '1' } })).toBe(true)
    expect(isAllowed({ method: 'PATCH', headers: { 'x-dsh-restart': '1' } })).toBe(false)
  })

  it('带 Origin 时必须与 Host 一致', () => {
    expect(
      isAllowed({
        method: 'POST',
        headers: { 'x-dsh-restart': '1', host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' },
      }),
    ).toBe(true)
    expect(
      isAllowed({
        method: 'POST',
        headers: { 'x-dsh-restart': '1', host: '127.0.0.1:3080', origin: 'http://evil.example' },
      }),
    ).toBe(false)
    expect(
      isAllowed({
        method: 'POST',
        headers: { 'x-dsh-restart': '1', host: '127.0.0.1:3080', origin: 'not a url' },
      }),
    ).toBe(false)
  })
})

describe('插件入口', () => {
  it('导出宿主需要的 name / inject', () => {
    expect(name).toBe('dsh-restart')
    expect(inject).toContain('webServer')
  })

  it('apply 用 ctx.effect 注册三条 exact 路由', () => {
    const fake = makeCtx()
    apply(fake.ctx)
    expect([...fake.routes.keys()].sort()).toEqual([STATUS_PATH, PRECHECK_PATH, RESTART_PATH].sort())
    expect(fake.routes.get(STATUS_PATH)?.kind).toBe('exact')
    expect(fake.labels).toHaveLength(3)
  })

  it('三条路径就是 Task 5 helper 写的字面量', () => {
    expect(STATUS_PATH).toBe('/dsh-restart/api/status')
    expect(PRECHECK_PATH).toBe('/dsh-restart/api/precheck')
    expect(RESTART_PATH).toBe('/dsh-restart/api/restart')
  })

  it('Config 不吞配置：空对象/缺省通过，带任何字段都报 issue', () => {
    const validate = Config['~standard'].validate
    expect(validate(undefined)).toEqual({ value: {} })
    expect(validate({})).toEqual({ value: {} })
    const result = validate({ foo: 1 }) as { issues?: Array<{ message: string }> }
    expect(result.issues?.[0]?.message).toContain('没有配置项')
  })
})

describe('请求门（路由层）', () => {
  it('connection 拒绝时三条路由都 403', async () => {
    const fake = makeCtx({ profile: PROFILE, rejection: 403 })
    const { io } = makeIo()
    const handlers = createHandlers(fake.ctx, io)
    for (const handler of [handlers.status, handlers.precheck, handlers.restart]) {
      const res = await call(handler, makeReq({ method: 'POST' }), makeRes())
      expect(res.statusCode).toBe(403)
    }
  })

  it('缺 x-dsh-restart 头时 403', async () => {
    const fake = makeCtx({ profile: PROFILE })
    const { io } = makeIo()
    const res = await call(createHandlers(fake.ctx, io).precheck, makeReq({ method: 'POST', headers: { 'x-dsh-restart': '' } }), makeRes())
    expect(res.statusCode).toBe(403)
  })

  it('GET 打 restart / precheck 为 403，且不排重启', async () => {
    const fake = makeCtx({ profile: PROFILE })
    const scheduled: unknown[] = []
    const { io } = makeIo({ scheduleRestart: (options) => scheduled.push(options) })
    const handlers = createHandlers(fake.ctx, io)
    for (const handler of [handlers.restart, handlers.precheck]) {
      const res = await call(handler, makeReq({ method: 'GET' }), makeRes())
      expect(res.statusCode).toBe(403)
    }
    expect(scheduled).toHaveLength(0)
  })

  it('POST 打 status 为 403（status 只收 GET）', async () => {
    const fake = makeCtx({ profile: PROFILE })
    const { io } = makeIo()
    const res = await call(createHandlers(fake.ctx, io).status, makeReq({ method: 'POST' }), makeRes())
    expect(res.statusCode).toBe(403)
  })
})

describe('GET /dsh-restart/api/status', () => {
  it('返回端口、健康、上次结果与过期判定', async () => {
    const fake = makeCtx({ profile: PROFILE, port: 3080 })
    const record: LastRecord = {
      fingerprint: FP,
      baseline: ['old'],
      precheck: { at: '2026-11-23T11:00:00.000Z', ok: true, fingerprint: FP, failures: [], durationMs: 10 },
    }
    const probes: number[] = []
    const { io } = makeIo({
      readLast: async () => record,
      computeFingerprint: async () => FP,
      probeHealth: async (port) => {
        probes.push(port)
        return true
      },
      isRefused: async () => true,
    })
    const res = await call(createHandlers(fake.ctx, io).status, makeReq({ method: 'GET' }), makeRes())
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('application/json')
    expect(json(res)).toMatchObject({
      ok: true,
      port: 3080,
      health: true,
      stale: false,
      fingerprint: FP,
      restarting: true,
      logDir: io.logDir,
      profileName: PROFILE.name,
      last: record,
    })
    expect(probes).toEqual([3080])
  })

  it('last.json 不存在也返回 200：顶层显式 null，last 为空对象', async () => {
    const fake = makeCtx({ profile: PROFILE, omitPort: true })
    const { io } = makeIo({ readLast: async () => ({}) })
    const res = await call(createHandlers(fake.ctx, io).status, makeReq({ method: 'GET' }), makeRes())
    expect(res.statusCode).toBe(200)
    expect(json(res)).toMatchObject({ ok: true, port: null, stale: true, last: {} })
  })

  it('指纹对不上时 stale=true', async () => {
    const fake = makeCtx({ profile: PROFILE })
    const { io } = makeIo({ readLast: async () => ({ fingerprint: 'ffffffffffffffff' }), computeFingerprint: async () => FP })
    const res = await call(createHandlers(fake.ctx, io).status, makeReq({ method: 'GET' }), makeRes())
    expect(json(res).stale).toBe(true)
  })

  it('profileContext 缺失时 503', async () => {
    const fake = makeCtx()
    const { io } = makeIo()
    const res = await call(createHandlers(fake.ctx, io).status, makeReq({ method: 'GET' }), makeRes())
    expect(res.statusCode).toBe(503)
  })

  it('connection 服务缺失时 fail-closed 为 503', async () => {
    const fake = makeCtx({ profile: PROFILE, omitConnection: true })
    const { io } = makeIo()
    const res = await call(createHandlers(fake.ctx, io).status, makeReq({ method: 'GET' }), makeRes())
    expect(res.statusCode).toBe(503)
  })

  it('helper 的本机只读探针在 requestRejection=401 时仍返回 200', async () => {
    const fake = makeCtx({ profile: PROFILE, rejection: 401 })
    const { io } = makeIo()
    const res = await call(createHandlers(fake.ctx, io).status, makeReq({ method: 'GET' }), makeRes())
    expect(res.statusCode).toBe(200)
    expect(json(res)).toMatchObject({ ok: true })
  })

  it('401 例外只给回环地址，非回环仍 401', async () => {
    const fake = makeCtx({ profile: PROFILE, rejection: 401 })
    const { io } = makeIo()
    const res = await call(
      createHandlers(fake.ctx, io).status,
      makeReq({ method: 'GET', remoteAddress: '10.0.0.5' }),
      makeRes(),
    )
    expect(res.statusCode).toBe(401)
  })

  it('带 Origin 的本机请求不享受 401 例外', async () => {
    const fake = makeCtx({ profile: PROFILE, rejection: 401 })
    const { io } = makeIo()
    const res = await call(
      createHandlers(fake.ctx, io).status,
      makeReq({ method: 'GET', headers: { origin: 'http://127.0.0.1:3080' } }),
      makeRes(),
    )
    expect(res.statusCode).toBe(401)
  })

  it('带代理转发头或 Host 不是回环时不享受 401 例外', async () => {
    const fake = makeCtx({ profile: PROFILE, rejection: 401 })
    const { io } = makeIo()
    const handlers = createHandlers(fake.ctx, io)
    const forwarded = await call(
      handlers.status,
      makeReq({ method: 'GET', headers: { 'x-forwarded-for': '203.0.113.9' } }),
      makeRes(),
    )
    expect(forwarded.statusCode).toBe(401)
    const publicHost = await call(
      handlers.status,
      makeReq({ method: 'GET', headers: { host: 'dsh.example.com' } }),
      makeRes(),
    )
    expect(publicHost.statusCode).toBe(401)
  })

  it('401 例外绑定 status 路径：同一 handler 收到别的 URL 仍 401', async () => {
    const fake = makeCtx({ profile: PROFILE, rejection: 401 })
    const { io } = makeIo()
    const res = await call(
      createHandlers(fake.ctx, io).status,
      makeReq({ method: 'GET', url: '/dsh-restart/api/precheck' }),
      makeRes(),
    )
    expect(res.statusCode).toBe(401)
  })

  it('precheck / restart 的 POST 不享受 401 例外，且没有副作用', async () => {
    const fake = makeCtx({ profile: PROFILE, rejection: 401 })
    let smokeCalls = 0
    let writeCalls = 0
    const scheduled: unknown[] = []
    const { io } = makeIo({
      runSmoke: async () => {
        smokeCalls += 1
        return smoke()
      },
      writeLast: async () => {
        writeCalls += 1
      },
      scheduleRestart: (options) => scheduled.push(options),
    })
    const handlers = createHandlers(fake.ctx, io)
    const precheckRes = await call(handlers.precheck, makeReq({ method: 'POST' }), makeRes())
    const restartRes = await call(handlers.restart, makeReq({ method: 'POST' }), makeRes())
    expect(precheckRes.statusCode).toBe(401)
    expect(restartRes.statusCode).toBe(401)
    expect(smokeCalls).toBe(0)
    expect(writeCalls).toBe(0)
    expect(scheduled).toHaveLength(0)
  })
})

describe('POST /dsh-restart/api/precheck', () => {
  it('按 config → compat → boot 逐行推送 NDJSON，结尾 done', async () => {
    const fake = makeCtx({ profile: PROFILE })
    const res = makeRes()
    const { io } = makeIo()
    const handlers = createHandlers(fake.ctx, io)
    await call(handlers.precheck, makeReq({ method: 'POST' }), res)

    expect(res.headers['content-type']).toContain('application/x-ndjson')
    const lines = ndjson(res)
    expect(lines.slice(0, 3).map((line) => line.stage)).toEqual(['config', 'compat', 'boot'])
    expect(lines.at(-1)).toMatchObject({ done: true, ok: true, saved: true, fingerprint: FP })
    for (const line of lines.slice(0, 3)) {
      expect(line).toMatchObject({ ok: true, failures: [] })
    }
  })

  it('快检 A/B 在冒烟开始前就已经写出去（不攒到最后）', async () => {
    const fake = makeCtx({ profile: PROFILE })
    const res = makeRes()
    let linesSeenWhenSmokeStarts = -1
    const { io } = makeIo({
      runSmoke: async () => {
        linesSeenWhenSmokeStarts = ndjson(res).length
        return smoke()
      },
    })
    await call(createHandlers(fake.ctx, io).precheck, makeReq({ method: 'POST' }), res)
    expect(linesSeenWhenSmokeStarts).toBe(2)
  })

  it('冒烟跑完才发现客户端断开：阶段结论不落盘', async () => {
    const fake = makeCtx({ profile: PROFILE })
    let res: FakeRes | undefined
    let writeCalls = 0
    const { io } = makeIo({
      runSmoke: async () => {
        res?.emit('close')
        return smoke({ failedEntries: ['new'] })
      },
      writeLast: async () => {
        writeCalls += 1
      },
    })
    res = makeRes()
    await call(createHandlers(fake.ctx, io).precheck, makeReq({ method: 'POST' }), res)
    expect(writeCalls).toBe(0)
    const lines = ndjson(res)
    expect(lines.find((line) => line.stage === 'boot')).toMatchObject({ cancelled: true, ok: false })
    expect(lines.at(-1)).toMatchObject({ done: true, saved: false, cancelled: true })
  })

  it('已有一轮预检时第二次直接 409，不排队也不重复跑', async () => {
    const fake = makeCtx({ profile: PROFILE })
    let releaseConfig: (value: Failure[]) => void = () => {}
    const configGate = new Promise<Failure[]>((resolve) => {
      releaseConfig = resolve
    })
    let configCalls = 0
    const { io } = makeIo({
      runDumpConfig: async () => {
        configCalls += 1
        return configGate
      },
    })
    const handlers = createHandlers(fake.ctx, io)
    const first = call(handlers.precheck, makeReq({ method: 'POST' }), makeRes())
    const secondRes = await call(handlers.precheck, makeReq({ method: 'POST' }), makeRes())
    expect(secondRes.statusCode).toBe(409)
    expect(secondRes.headers['content-type']).toContain('application/json')
    expect(configCalls).toBe(1)
    releaseConfig([])
    await first
  })

  it('客户端在快检阶段断开：不跑冒烟、不写盘，流里标记 cancelled 并释放互斥', async () => {
    const fake = makeCtx({ profile: PROFILE })
    let firstRes: FakeRes | undefined
    let smokeCalls = 0
    let writeCalls = 0
    const { io } = makeIo({
      runDumpConfig: async () => {
        firstRes?.emit('close')
        return []
      },
      runSmoke: async () => {
        smokeCalls += 1
        return smoke()
      },
      writeLast: async () => {
        writeCalls += 1
      },
    })
    const handlers = createHandlers(fake.ctx, io)
    firstRes = makeRes()
    const first = await call(handlers.precheck, makeReq({ method: 'POST' }), firstRes)
    expect(smokeCalls).toBe(0)
    expect(writeCalls).toBe(0)
    expect(ndjson(first).at(-1)).toMatchObject({
      done: true,
      ok: false,
      saved: false,
      cancelled: true,
      reason: 'cancelled',
    })

    // 取消后 finally 必须释放锁，下一轮还能正常跑。
    const second = await call(handlers.precheck, makeReq({ method: 'POST' }), makeRes())
    expect(second.statusCode).toBe(200)
    expect(ndjson(second).at(-1)).toMatchObject({ done: true, ok: true, saved: true })
  })

  it('通过时写入 precheck + baseline + 指纹；三行都 ok', async () => {
    const fake = makeCtx({ profile: PROFILE })
    const writes: Array<Partial<LastRecord>> = []
    const { io } = makeIo({
      readLast: async () => ({ baseline: ['old'], fingerprint: FP }),
      runSmoke: async () => smoke({ failedEntries: ['old'] }),
      writeLast: async (_dir, patch) => {
        writes.push(patch)
      },
    })
    const res = await call(createHandlers(fake.ctx, io).precheck, makeReq({ method: 'POST' }), makeRes())
    expect(ndjson(res).at(-1)).toMatchObject({ done: true, ok: true, saved: true, fingerprint: FP })
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({
      fingerprint: FP,
      baseline: ['old'],
      precheck: { ok: true, fingerprint: FP, failures: [] },
    })
  })

  it('冒烟 ok 但出现基线之外的新条目：boot 阶段不通过，也不动基线', async () => {
    const fake = makeCtx({ profile: PROFILE })
    const writes: Array<Partial<LastRecord>> = []
    const { io } = makeIo({
      readLast: async () => ({ baseline: ['old'] }),
      runSmoke: async () => smoke({ failedEntries: ['old', 'new'] }),
      writeLast: async (_dir, patch) => {
        writes.push(patch)
      },
    })
    const res = await call(createHandlers(fake.ctx, io).precheck, makeReq({ method: 'POST' }), makeRes())
    const boot = ndjson(res).find((line) => line.stage === 'boot') as { ok: boolean; failures: Failure[]; added: string[] }
    expect(boot.ok).toBe(false)
    expect(boot.added).toEqual(['new'])
    expect(boot.failures.some((failure) => failure.plugin === 'new')).toBe(true)
    expect(writes).toHaveLength(1)
    expect(writes[0]?.baseline).toBeUndefined()
    expect(writes[0]?.precheck).toMatchObject({ ok: false })
    expect(writes[0]?.precheck?.failures.some((failure) => failure.plugin === 'new')).toBe(true)
    // 未通过也同步指纹，只是基线不动（Task 2 的不变量）。
    expect(writes[0]?.fingerprint).toBe(FP)
  })

  it('快检失败后仍继续跑后面的阶段', async () => {
    const fake = makeCtx({ profile: PROFILE })
    const { io } = makeIo({
      runDumpConfig: async () => [{ kind: 'config', message: 'dump 挂了' } satisfies Failure],
    })
    const res = await call(createHandlers(fake.ctx, io).precheck, makeReq({ method: 'POST' }), makeRes())
    const lines = ndjson(res)
    expect(lines.slice(0, 3).map((line) => line.stage)).toEqual(['config', 'compat', 'boot'])
    expect(lines[0]).toMatchObject({ ok: false })
    expect(lines[1]).toMatchObject({ ok: true })
  })

  it('快检抛异常也变成该阶段的失败，不让流断掉', async () => {
    const fake = makeCtx({ profile: PROFILE })
    const { io } = makeIo({
      runDumpConfig: async () => {
        throw new Error('spawn ENOENT')
      },
      runSmoke: async () => {
        throw new Error('clone failed')
      },
    })
    const res = await call(createHandlers(fake.ctx, io).precheck, makeReq({ method: 'POST' }), makeRes())
    const lines = ndjson(res)
    expect(lines).toHaveLength(4)
    expect(lines[0]).toMatchObject({ stage: 'config', ok: false })
    expect(String((lines[0]?.failures as Failure[])[0]?.message)).toContain('spawn ENOENT')
    expect(lines[2]).toMatchObject({ stage: 'boot', ok: false })
    expect(lines.at(-1)).toMatchObject({ done: true, ok: false, saved: true, fingerprint: FP })
  })

  it('指纹为 null 时不写 last.json', async () => {
    const fake = makeCtx({ profile: PROFILE })
    let wrote = false
    const { io } = makeIo({
      computeFingerprint: async () => null,
      writeLast: async () => {
        wrote = true
      },
    })
    const res = await call(createHandlers(fake.ctx, io).precheck, makeReq({ method: 'POST' }), makeRes())
    expect(ndjson(res).at(-1)).toMatchObject({
      done: true,
      ok: true,
      saved: false,
      reason: 'fingerprint-unavailable',
    })
    expect(wrote).toBe(false)
  })

  it('profileContext 缺失时 503（JSON，不是 NDJSON）', async () => {
    const fake = makeCtx()
    const { io } = makeIo()
    const res = await call(createHandlers(fake.ctx, io).precheck, makeReq({ method: 'POST' }), makeRes())
    expect(res.statusCode).toBe(503)
    expect(res.headers['content-type']).toContain('application/json')
    expect(json(res)).toMatchObject({ ok: false })
  })
})

describe('POST /dsh-restart/api/restart', () => {
  it('先回 202，响应 finish 之后才派生 helper', async () => {
    const fake = makeCtx({ profile: PROFILE, port: 3080 })
    const scheduled: unknown[] = []
    let endedWhenScheduled = false
    let res: FakeRes
    const { io } = makeIo({
      scheduleRestart: (options) => {
        endedWhenScheduled = res.writableEnded
        scheduled.push(options)
      },
    })
    res = makeRes()
    await call(createHandlers(fake.ctx, io).restart, makeReq({ method: 'POST' }), res)

    expect(res.statusCode).toBe(202)
    expect(json(res)).toMatchObject({
      ok: true,
      port: 3080,
      logDir: io.logDir,
      profileName: PROFILE.name,
    })
    expect(res.chunks).toHaveLength(1)
    expect(endedWhenScheduled).toBe(true)
    expect(scheduled).toEqual([
      { port: 3080, profileDir: PROFILE.dir, logDir: io.logDir, dshHome: PROFILE.home, profileName: PROFILE.name },
    ])
  })

  it('客户端在 202 写完前断开（只有 close 没有 finish）也派生 helper', async () => {
    const fake = makeCtx({ profile: PROFILE, port: 3080 })
    const scheduled: unknown[] = []
    const { io } = makeIo({ scheduleRestart: (options) => scheduled.push(options) })
    const res = makeRes({ suppressFinish: true })
    await call(createHandlers(fake.ctx, io).restart, makeReq({ method: 'POST' }), res)
    expect(res.statusCode).toBe(202)
    expect(scheduled).toHaveLength(1)
  })

  it('同一进程内双击：第二个 409，只派生一个 helper', async () => {
    const fake = makeCtx({ profile: PROFILE, port: 3080 })
    let releaseRefused: (value: boolean) => void = () => {}
    const refusedGate = new Promise<boolean>((resolve) => {
      releaseRefused = resolve
    })
    let refusedCalls = 0
    const scheduled: unknown[] = []
    const { io } = makeIo({
      isRefused: async () => {
        refusedCalls += 1
        return refusedGate
      },
      scheduleRestart: (options) => scheduled.push(options),
    })
    const handlers = createHandlers(fake.ctx, io)
    const firstRes = makeRes()
    const first = call(handlers.restart, makeReq({ method: 'POST' }), firstRes)
    const secondRes = await call(handlers.restart, makeReq({ method: 'POST' }), makeRes())
    expect(secondRes.statusCode).toBe(409)
    expect(refusedCalls).toBe(1)
    releaseRefused(false)
    await first
    expect(firstRes.statusCode).toBe(202)
    expect(scheduled).toHaveLength(1)
  })

  it('已有重启锁时 409，且不排重启', async () => {
    const fake = makeCtx({ profile: PROFILE })
    const scheduled: unknown[] = []
    const { io } = makeIo({ isRefused: async () => true, scheduleRestart: (options) => scheduled.push(options) })
    const res = await call(createHandlers(fake.ctx, io).restart, makeReq({ method: 'POST' }), makeRes())
    expect(res.statusCode).toBe(409)
    expect(scheduled).toHaveLength(0)
  })

  it('拿不到端口时 503，不排重启', async () => {
    const fake = makeCtx({ profile: PROFILE, omitPort: true })
    const scheduled: unknown[] = []
    const { io } = makeIo({ scheduleRestart: (options) => scheduled.push(options) })
    const res = await call(createHandlers(fake.ctx, io).restart, makeReq({ method: 'POST' }), makeRes())
    expect(res.statusCode).toBe(503)
    expect(scheduled).toHaveLength(0)
  })
})
