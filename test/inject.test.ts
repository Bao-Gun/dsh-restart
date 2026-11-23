// @vitest-environment jsdom
/**
 * Task 7：菜单注入与重启弹窗的失败测试。
 *
 * 这里的 DOM 结构照实机取证写：
 * - 菜单是 portal 到 body 的 `<div role="menu">`，里面每行是
 *   `<div class="_itemWrap_...">` 包一个 `<button role="menuitem">`（见
 *   dsh-web-frontend/dist/assets/index-*.js 的 Zu 组件）。
 * - 账号菜单的按钮列有「设置 / 联系我们 / 退出登录」三行，我们要插在退出登录之前。
 *
 * 全程不发真实网络请求：fetch 是注入的假实现。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_DEBOUNCE_MS, injectMenuRow } from '../src/client/inject'
import { mountDialog } from '../src/client/dialog'

const ITEM_WRAP = '_itemWrap_70kcw_173'
const ITEM = '_item_70kcw_173'
const ITEM_ICON = '_itemIcon_70kcw_233'
const ITEM_LABEL = '_itemLabel_70kcw_276'

function menuItem(label: string): string {
  return (
    '<div class="' + ITEM_WRAP + '">' +
    '<button type="button" role="menuitem" class="' + ITEM + '">' +
    '<span aria-hidden="true" class="' + ITEM_ICON + '"></span>' +
    '<span class="' + ITEM_LABEL + '">' + label + '</span>' +
    '</button></div>'
  )
}

function accountMenu(): string {
  return (
    '<div class="_root_70kcw_1" style="display:contents">' +
    '<div role="menu" class="_list_70kcw_7">' +
    '<div class="_viewport_70kcw_19" role="presentation">' +
    menuItem('设置') + menuItem('联系我们') + menuItem('退出登录') +
    '</div></div></div>'
  )
}

function fallbackOnly(): string {
  return '<div data-slot="settings.launcher" style="display:contents"><button type="button" class="yHnPSG_trigger" data-collapsed="false"><span class="yHnPSG_label">更多</span></button></div>'
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function rows(doc: Document): Element[] {
  return Array.from(doc.querySelectorAll('[data-dsh-restart-row]'))
}

describe('injectMenuRow：插在账号菜单倒数第二行', () => {
  beforeEach(() => {
    document.body.innerHTML = fallbackOnly() + accountMenu()
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('默认防抖是 100ms', () => {
    expect(DEFAULT_DEBOUNCE_MS).toBe(100)
  })

  it('插在最后一项（退出登录）之前，成为倒数第二行', () => {
    const dispose = injectMenuRow(document, { onOpen: () => undefined })
    try {
      const items = Array.from(document.querySelectorAll('[role="menu"] button[role="menuitem"]'))
      expect(items).toHaveLength(4)
      expect(items[2]?.hasAttribute('data-dsh-restart-row')).toBe(true)
      expect(items[2]?.textContent).toBe('重启')
      expect(items[3]?.textContent).toContain('退出登录')
      // 外面包一层和相邻行一样的 itemWrap，行高/间距才能对上。
      expect(items[2]?.parentElement?.className).toBe(ITEM_WRAP)
      expect(items[2]?.className).toBe(ITEM)
    } finally {
      dispose()
    }
  })

  it('同一 DOM 重复调用不会出现两行', () => {
    const disposeA = injectMenuRow(document, { onOpen: () => undefined })
    const disposeB = injectMenuRow(document, { onOpen: () => undefined })
    try {
      expect(rows(document)).toHaveLength(1)
      expect(document.querySelectorAll('[role="menu"] button[role="menuitem"]')).toHaveLength(4)
    } finally {
      disposeB()
      disposeA()
    }
  })

  it('自建行被删掉后由 MutationObserver 补挂回来', async () => {
    const dispose = injectMenuRow(document, { onOpen: () => undefined, debounceMs: 5 })
    try {
      rows(document)[0]?.remove()
      expect(rows(document)).toHaveLength(0)
      await wait(60)
      expect(rows(document)).toHaveLength(1)
      const items = Array.from(document.querySelectorAll('[role="menu"] button[role="menuitem"]'))
      expect(items[items.length - 2]?.hasAttribute('data-dsh-restart-row')).toBe(true)
    } finally {
      dispose()
    }
  })

  it('菜单重新打开（整棵弹层换掉）也能补挂', async () => {
    const dispose = injectMenuRow(document, { onOpen: () => undefined, debounceMs: 5 })
    try {
      document.body.innerHTML = fallbackOnly() + accountMenu()
      await wait(60)
      expect(rows(document)).toHaveLength(1)
    } finally {
      dispose()
    }
  })

  it('点击自建行执行 onOpen', () => {
    const onOpen = vi.fn()
    const dispose = injectMenuRow(document, { onOpen })
    try {
      const row = rows(document)[0]
      row?.dispatchEvent(new document.defaultView!.MouseEvent('click', { bubbles: true }))
      expect(onOpen).toHaveBeenCalledTimes(1)
    } finally {
      dispose()
    }
  })

  it('cleanup 之后不再补挂', async () => {
    const dispose = injectMenuRow(document, { onOpen: () => undefined, debounceMs: 5 })
    dispose()
    expect(rows(document)).toHaveLength(0)
    document.body.innerHTML = fallbackOnly() + accountMenu()
    await wait(60)
    expect(rows(document)).toHaveLength(0)
  })
})

describe('injectMenuRow：没有菜单时什么都不插', () => {
  beforeEach(() => {
    document.body.innerHTML = fallbackOnly()
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  // 侧栏底部那条退路会把「更多」挤成第二行（实机上「更多」直接不见了），
  // 所以菜单没打开时宁可什么都不插，等菜单出现再补。
  it('侧栏底部不另起一行', () => {
    const dispose = injectMenuRow(document, { onOpen: () => undefined, debounceMs: 5 })
    try {
      const launcher = document.querySelector('[data-slot="settings.launcher"]')
      expect(launcher?.previousElementSibling?.hasAttribute('data-dsh-restart-launcher-row')).not.toBe(true)
      expect(document.querySelectorAll('[data-dsh-restart-launcher-row]')).toHaveLength(0)
      expect(rows(document)).toHaveLength(0)
    } finally {
      dispose()
    }
  })

  // 实机反馈：菜单弹出来之后才插行，能看见「先空着、再冒出来」的一瞬。
  // 现在菜单一挂上来就在 MutationObserver 的微任务里补，赶在绘制之前。
  it('菜单一出现就当场补行，不等防抖窗口', async () => {
    // debounce 给 5 秒：只有「立刻插」这条路径能让它出现。
    const dispose = injectMenuRow(document, { onOpen: () => undefined, debounceMs: 5000 })
    try {
      document.body.innerHTML = fallbackOnly() + accountMenu()
      await wait(0)
      expect(rows(document)).toHaveLength(1)
    } finally {
      dispose()
    }
  })

  it('菜单后来才出现，也能补挂进去', async () => {
    const dispose = injectMenuRow(document, { onOpen: () => undefined, debounceMs: 5 })
    try {
      expect(rows(document)).toHaveLength(0)
      document.body.innerHTML = fallbackOnly() + accountMenu()
      await wait(60)
      expect(rows(document)).toHaveLength(1)
    } finally {
      dispose()
    }
  })
})

/* ------------------------------------------------------------------ */
/* 弹窗                                                                */
/* ------------------------------------------------------------------ */

type FetchCall = { url: string; init: { method?: string; headers?: Record<string, string>; signal?: AbortSignal } }

interface FakeResponse {
  ok: boolean
  status: number
  json(): Promise<unknown>
  text(): Promise<string>
  body: null | { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }> } }
}

function jsonResponse(payload: unknown, status = 200): FakeResponse {
  return {
    ok: status < 400,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
    body: null,
  }
}

/** 把 NDJSON 切成很小的块，顺便验证客户端自己按行缓冲，而不是等整包。 */
function ndjsonResponse(text: string, chunkSize = 5): FakeResponse {
  let offset = 0
  return {
    ok: true,
    status: 200,
    json: async () => ({}),
    text: async () => text,
    body: {
      getReader() {
        return {
          async read() {
            if (offset >= text.length) return { done: true as const, value: undefined }
            const chunk = text.slice(offset, offset + chunkSize)
            offset += chunkSize
            return { done: false, value: new TextEncoder().encode(chunk) }
          },
        }
      },
    },
  }
}

function statusPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    at: '2026-11-23T04:00:00.000Z',
    port: 3080,
    health: true,
    stale: false,
    fingerprint: 'fp-1',
    restarting: false,
    last: {},
    ...overrides,
  }
}

function fakeFetch(routes: Record<string, FakeResponse | (() => FakeResponse)>): {
  calls: FetchCall[]
  fetchImpl: (url: string, init: FetchCall['init']) => Promise<FakeResponse>
} {
  const calls: FetchCall[] = []
  const fetchImpl = async (url: string, init: FetchCall['init']): Promise<FakeResponse> => {
    calls.push({ url, init })
    const route = routes[url]
    if (route === undefined) throw new Error('unexpected fetch: ' + url)
    return typeof route === 'function' ? route() : route
  }
  return { calls, fetchImpl }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve()
}

/** 一条永远读不完的 NDJSON 流：用来验证 close() 有没有真的 abort + cancel。 */
function slowStream(line: Record<string, unknown>): {
  response: FakeResponse
  state: { reads: number; cancelled: boolean }
} {
  const state = { reads: 0, cancelled: false }
  const encoder = new TextEncoder()
  const response: FakeResponse = {
    ok: true,
    status: 200,
    json: async () => ({}),
    text: async () => '',
    body: {
      getReader() {
        return {
          async read() {
            state.reads += 1
            if (state.cancelled) return { done: true as const, value: undefined }
            await wait(10)
            if (state.cancelled) return { done: true as const, value: undefined }
            return { done: false as const, value: encoder.encode(JSON.stringify(line) + '\n') }
          },
          async cancel() {
            state.cancelled = true
          },
        }
      },
    },
  }
  return { response, state }
}

/** 手动推行的 NDJSON 流：验证「一条 stage 到就渲染一条」，而不是等整包。 */
function manualNdjson(): { response: FakeResponse; push(text: string): void; finish(): void } {
  const encoder = new TextEncoder()
  const queue: string[] = []
  let pending: ((chunk: { done: boolean; value?: Uint8Array }) => void) | null = null
  let finished = false
  const response: FakeResponse = {
    ok: true,
    status: 200,
    json: async () => ({}),
    text: async () => '',
    body: {
      getReader() {
        return {
          read() {
            const next = queue.shift()
            if (next !== undefined) return Promise.resolve({ done: false, value: encoder.encode(next) })
            if (finished) return Promise.resolve({ done: true, value: undefined })
            return new Promise((resolve) => {
              pending = resolve
            })
          },
        }
      },
    },
  }
  const push = (text: string): void => {
    if (pending !== null) {
      const resolve = pending
      pending = null
      resolve({ done: false, value: encoder.encode(text) })
      return
    }
    queue.push(text)
  }
  const finish = (): void => {
    finished = true
    if (pending !== null) {
      const resolve = pending
      pending = null
      resolve({ done: true, value: undefined })
    }
  }
  return { response, push, finish }
}

function noticeText(): string {
  return document.querySelector('.dsh-restart-notice')?.textContent?.trim() ?? ''
}

/**
 * 流式响应是逐块读的，一块一次微任务，固定跳几次微任务等不完。
 * 这里按真实时钟轮询「界面到我预期的状态没有」，断言本身不含超时容忍。
 */
async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const startedAt = Date.now()
  for (;;) {
    if (check()) return
    if (Date.now() - startedAt > timeoutMs) throw new Error('waitFor 超时：界面没到预期状态')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function restartButton(): HTMLButtonElement {
  return document.querySelector('[data-dsh-restart-restart]') as HTMLButtonElement
}

function ackInput(): HTMLInputElement {
  return document.querySelector('[data-dsh-restart-ack]') as HTMLInputElement
}

/** 勾选框外层 label：显隐在 label 上，input 本身不被隐藏。 */
function ackWrap(): HTMLElement {
  return document.querySelector('[data-dsh-restart-ack-wrap]') as HTMLElement
}

function dialogRoot(): Element | null {
  return document.querySelector('[data-dsh-restart-dialog]')
}

function textOf(selector: string): string {
  return document.querySelector(selector)?.textContent?.trim() ?? ''
}

describe('mountDialog：五段与状态', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  afterEach(() => {
    document.body.innerHTML = ''
    vi.useRealTimers()
  })

  it('open 后从 status 填端口、健康与上次结果', async () => {
    const { calls, fetchImpl } = fakeFetch({
      '/dsh-restart/api/status': jsonResponse(statusPayload({
        last: {
          precheck: { at: '2026-11-23T03:00:00.000Z', ok: true, fingerprint: 'fp-1', failures: [], durationMs: 1200 },
        },
      })),
    })
    const dialog = mountDialog(document, { fetchImpl })
    dialog.open()
    await settle()

    expect(dialogRoot()).not.toBeNull()
    expect(textOf('[data-dsh-restart-port]')).toContain('3080')
    expect(textOf('[data-dsh-restart-health]')).toContain('正常')
    expect(textOf('[data-dsh-restart-last]')).toContain('通过')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('/dsh-restart/api/status')
    expect(calls[0]?.init.headers?.['x-dsh-restart']).toBe('1')
    // 勾选框常显、默认不勾；按钮随时能点（点了会先预检）。
    expect(ackWrap().hidden).toBe(false)
    expect(ackInput().checked).toBe(false)
    expect(restartButton().disabled).toBe(false)
  })

  it('上次结果的时间按本机时区显示，不直接切 ISO 字符串', async () => {
    // 服务端落盘的是 UTC ISO；直接 slice 会在 UTC+8 机器上少 8 小时（2026-11-23 真机：显示 14:26，实际 22:26）。
    const at = '2026-11-23T15:03:37.011Z'
    const { fetchImpl } = fakeFetch({
      '/dsh-restart/api/status': jsonResponse(statusPayload({
        last: { precheck: { at, ok: true, fingerprint: 'fp-1', failures: [], durationMs: 1200 } },
      })),
    })
    const dialog = mountDialog(document, { fetchImpl })
    dialog.open()
    await settle()

    const local = new Date(at)
    const pad = (n: number): string => String(n).padStart(2, '0')
    const expected = String(local.getFullYear()) + '-' + pad(local.getMonth() + 1) + '-' + pad(local.getDate())
      + ' ' + pad(local.getHours()) + ':' + pad(local.getMinutes())
    const rendered = textOf('[data-dsh-restart-last]')
    expect(rendered).toContain(expected)
    if (local.getTimezoneOffset() !== 0) expect(rendered).not.toContain(at.slice(0, 16).replace('T', ' '))
  })

  it('指纹过期：按钮照样能点，点下去会重新检查', async () => {
    const { fetchImpl } = fakeFetch({
      '/dsh-restart/api/status': jsonResponse(statusPayload({
        stale: true,
        last: { precheck: { at: '2026-11-23T03:00:00.000Z', ok: true, fingerprint: 'fp-old', failures: [], durationMs: 900 } },
      })),
    })
    const dialog = mountDialog(document, { fetchImpl })
    dialog.open()
    await settle()

    expect(textOf('[data-dsh-restart-last]')).toContain('已过期')
    expect(noticeText()).toContain('这次重启会重新检查')
    expect(restartButton().disabled).toBe(false)
  })

  it('点重启先跑预检：NDJSON 逐行渲染，判红不发重启请求', async () => {
    const lines = [
      JSON.stringify({ stage: 'config', ok: true, failures: [] }),
      JSON.stringify({
        stage: 'compat',
        ok: false,
        failures: [{ kind: 'compat', plugin: 'bad-plugin', message: 'engines.dsh 不满足', expected: '>=0.2.2', actual: '0.1.0' }],
      }),
      JSON.stringify({ stage: 'boot', ok: true, failures: [], entries: [], added: [], health: true }),
      JSON.stringify({ done: true }),
    ].join('\n') + '\n'

    const { calls, fetchImpl } = fakeFetch({
      '/dsh-restart/api/status': jsonResponse(statusPayload()),
      '/dsh-restart/api/precheck': ndjsonResponse(lines),
    })
    const dialog = mountDialog(document, { fetchImpl })
    dialog.open()
    await settle()

    restartButton().click()
    await waitFor(() => noticeText().includes('预检没通过'))

    const precheckCall = calls.find((call) => call.url === '/dsh-restart/api/precheck')
    expect(precheckCall?.init.method).toBe('POST')
    expect(precheckCall?.init.headers?.['x-dsh-restart']).toBe('1')
    expect(calls.filter((call) => call.url === '/dsh-restart/api/precheck')).toHaveLength(1)
    expect(textOf('[data-dsh-restart-stage="config"]')).toContain('通过')
    expect(textOf('[data-dsh-restart-stage="compat"]')).toContain('未通过')
    expect(textOf('[data-dsh-restart-stage="boot"]')).toContain('通过')
    const failures = document.querySelectorAll('[data-dsh-restart-failure]')
    expect(failures).toHaveLength(1)
    expect(failures[0]?.textContent).toContain('bad-plugin')
    expect(failures[0]?.textContent).toContain('>=0.2.2')
    expect(failures[0]?.textContent).toContain('0.1.0')
    expect(calls.some((call) => call.url === '/dsh-restart/api/restart')).toBe(false)
    expect(restartButton().disabled).toBe(false)
    expect(noticeText()).toContain('预检没通过（1 项）')
  })

  it('预检全过就自己发重启，不用点第二次', async () => {
    const lines = [
      JSON.stringify({ stage: 'config', ok: true, failures: [] }),
      JSON.stringify({ stage: 'compat', ok: true, failures: [] }),
      JSON.stringify({ stage: 'boot', ok: true, failures: [], entries: [], added: [], health: true }),
      JSON.stringify({ done: true }),
    ].join('\n') + '\n'

    const { calls, fetchImpl } = fakeFetch({
      '/dsh-restart/api/status': jsonResponse(statusPayload({ last: {} })),
      '/dsh-restart/api/precheck': ndjsonResponse(lines, 3),
      '/dsh-restart/api/restart': jsonResponse({ ok: true, at: '2026-11-23T04:00:01.000Z', port: 3080 }, 202),
    })
    const dialog = mountDialog(document, { fetchImpl, pollIntervalMs: 5000 })
    dialog.open()
    await settle()

    restartButton().click()
    await waitFor(() => calls.some((call) => call.url === '/dsh-restart/api/restart'))

    const precheckIndex = calls.findIndex((call) => call.url === '/dsh-restart/api/precheck')
    const restartIndex = calls.findIndex((call) => call.url === '/dsh-restart/api/restart')
    expect(precheckIndex).toBeGreaterThanOrEqual(0)
    expect(restartIndex).toBeGreaterThan(precheckIndex)
    expect(calls[precheckIndex]?.init.headers?.['x-dsh-restart']).toBe('1')
    const restartCall = calls[restartIndex]
    expect(restartCall?.init.method).toBe('POST')
    expect(restartCall?.init.headers?.['x-dsh-restart']).toBe('1')
    dialog.close()
  })

  it('插件问题只作提示：阶段仍算通过，提示单独列出，不拦重启', async () => {
    const lines = [
      JSON.stringify({ stage: 'config', ok: true, failures: [] }),
      JSON.stringify({
        stage: 'compat',
        ok: true,
        failures: [],
        warnings: [{ kind: 'compat', plugin: 'dsh-mcp-connector', message: '装了但没装好，跳过' }],
      }),
      JSON.stringify({
        stage: 'boot',
        ok: true,
        failures: [],
        warnings: [{ kind: 'boot', plugin: 'stale-plugin', message: '没有激活（不在上次通过的基线里）' }],
        entries: ['stale-plugin'],
        added: ['stale-plugin'],
        health: true,
      }),
      JSON.stringify({ done: true, ok: true, saved: true, fingerprint: 'fp-1' }),
    ].join('\n') + '\n'

    const { calls, fetchImpl } = fakeFetch({
      '/dsh-restart/api/status': jsonResponse(statusPayload({ last: {} })),
      '/dsh-restart/api/precheck': ndjsonResponse(lines, 3),
      '/dsh-restart/api/restart': jsonResponse({ ok: true, at: '2026-11-23T04:00:01.000Z', port: 3080 }, 202),
    })
    const dialog = mountDialog(document, { fetchImpl, pollIntervalMs: 5000 })
    dialog.open()
    await settle()
    restartButton().click()
    await waitFor(() => document.querySelectorAll('[data-dsh-restart-warning]').length === 2)

    expect(textOf('[data-dsh-restart-stage="compat"]')).toContain('通过')
    expect(textOf('[data-dsh-restart-stage="compat"]')).toContain('1 条提示')
    expect(textOf('[data-dsh-restart-stage="boot"]')).toContain('通过')
    const warnings = document.querySelectorAll('[data-dsh-restart-warning]')
    expect(warnings).toHaveLength(2)
    expect(warnings[0]?.textContent).toContain('dsh-mcp-connector')
    expect(warnings[1]?.textContent).toContain('stale-plugin')
    expect(document.querySelectorAll('[data-dsh-restart-failure]')).toHaveLength(0)
    // 提示不拦重启：检查过了就直接发出重启。
    await waitFor(() => calls.some((call) => call.url === '/dsh-restart/api/restart'))
    dialog.close()
  })

  it('标题和主按钮都叫「重启」，没有那句「最危险」小字', async () => {
    const { fetchImpl } = fakeFetch({ '/dsh-restart/api/status': jsonResponse(statusPayload({ last: {} })) })
    const dialog = mountDialog(document, { fetchImpl })
    dialog.open()
    await settle()

    expect(textOf('.dsh-restart-title')).toBe('重启')
    expect(restartButton().textContent).toBe('重启')
    expect(document.querySelector('[data-dsh-restart-precheck]')).toBeNull()
    expect(document.body.textContent).not.toContain('最危险')
    expect(document.body.textContent).not.toContain('本次检查为准')
  })

  it('判红后勾上「跳过检查」再点：直接重启，不再跑预检', async () => {
    const lines = [
      JSON.stringify({ stage: 'config', ok: false, failures: [{ kind: 'config', message: 'dump-config 挂了' }] }),
      JSON.stringify({ stage: 'compat', ok: true, failures: [] }),
      JSON.stringify({ stage: 'boot', ok: true, failures: [], entries: [], added: [], health: true }),
      JSON.stringify({ done: true }),
    ].join('\n') + '\n'

    const { calls, fetchImpl } = fakeFetch({
      '/dsh-restart/api/status': jsonResponse(statusPayload()),
      '/dsh-restart/api/precheck': ndjsonResponse(lines),
      '/dsh-restart/api/restart': jsonResponse({ ok: true, at: '2026-11-23T04:00:01.000Z', port: 3080 }, 202),
    })
    const dialog = mountDialog(document, { fetchImpl, pollIntervalMs: 5000 })
    dialog.open()
    await settle()
    restartButton().click()
    await waitFor(() => noticeText().includes('预检没通过'))
    expect(document.querySelectorAll('[data-dsh-restart-failure]')).toHaveLength(1)

    // 判红：勾选框本来就是常显的、没被自动勾上；重启请求一次都没发。
    expect(ackInput().checked).toBe(false)
    expect(calls.some((call) => call.url === '/dsh-restart/api/restart')).toBe(false)

    ackInput().click()
    expect(ackInput().checked).toBe(true)
    restartButton().click()
    await settle()
    // 勾上就跳过预检：precheck 仍是 1 次，restart 发了 1 次。
    expect(calls.filter((call) => call.url === '/dsh-restart/api/precheck')).toHaveLength(1)
    const restartCall = calls.find((call) => call.url === '/dsh-restart/api/restart')
    expect(restartCall?.init.method).toBe('POST')
    expect(restartCall?.init.headers?.['x-dsh-restart']).toBe('1')
    dialog.close()
  })

  it('勾上再取消：下一次点击重新预检', async () => {
    const lines = [
      JSON.stringify({ stage: 'config', ok: false, failures: [{ kind: 'config', message: 'dump-config 挂了' }] }),
      JSON.stringify({ stage: 'compat', ok: true, failures: [] }),
      JSON.stringify({ stage: 'boot', ok: true, failures: [], entries: [], added: [], health: true }),
      JSON.stringify({ done: true }),
    ].join('\n') + '\n'
    const { calls, fetchImpl } = fakeFetch({
      '/dsh-restart/api/status': jsonResponse(statusPayload()),
      '/dsh-restart/api/precheck': ndjsonResponse(lines),
    })
    const dialog = mountDialog(document, { fetchImpl })
    dialog.open()
    await settle()
    restartButton().click()
    await waitFor(() => noticeText().includes('预检没通过'))

    ackInput().click()
    expect(ackInput().checked).toBe(true)
    ackInput().click()
    expect(ackInput().checked).toBe(false)
    expect(restartButton().disabled).toBe(false)

    restartButton().click()
    await waitFor(() => calls.filter((call) => call.url === '/dsh-restart/api/precheck').length === 2)
  })

  it('勾上跳过检查：只发 restart，不发 precheck', async () => {
    const { calls, fetchImpl } = fakeFetch({
      '/dsh-restart/api/status': jsonResponse(statusPayload({ last: {} })),
      '/dsh-restart/api/restart': jsonResponse({ ok: true, at: '2026-11-23T04:00:01.000Z', port: 3080 }, 202),
    })
    const dialog = mountDialog(document, { fetchImpl, pollIntervalMs: 40, timeoutMs: 2000, reload: () => {} })
    dialog.open()
    await settle()

    ackInput().click()
    expect(ackInput().checked).toBe(true)
    restartButton().click()
    await waitFor(() => calls.some((call) => call.url === '/dsh-restart/api/restart'))
    expect(calls.some((call) => call.url === '/dsh-restart/api/precheck')).toBe(false)
    dialog.close()
  })

  it('restart 回 409：解锁但提示清楚，不补发', async () => {
    const { calls, fetchImpl } = fakeFetch({
      '/dsh-restart/api/status': jsonResponse(statusPayload({ last: {} })),
      '/dsh-restart/api/restart': jsonResponse({ error: '已经有一个重启在进行中' }, 409),
    })
    const dialog = mountDialog(document, { fetchImpl })
    dialog.open()
    await settle()

    ackInput().click()
    restartButton().click()
    await waitFor(() => noticeText().includes('已经有一个重启在进行中'))
    expect(restartButton().disabled).toBe(false)
    expect(ackInput().disabled).toBe(false)
    expect(calls.filter((call) => call.url === '/dsh-restart/api/restart')).toHaveLength(1)
    expect(calls.some((call) => call.url === '/dsh-restart/api/precheck')).toBe(false)
  })

  /* ---- 评审 C1/M1/M2 的回归用例 ---- */

  it('上次通过 + 本次判红：不会自动重启（C1）', async () => {
    const failing = [
      JSON.stringify({ stage: 'config', ok: true, failures: [] }),
      JSON.stringify({ stage: 'compat', ok: false, failures: [{ kind: 'compat', message: '插件版本不满足' }] }),
      JSON.stringify({ stage: 'boot', ok: true, failures: [], entries: [], added: [], health: true }),
      JSON.stringify({ done: true }),
    ].join('\n') + '\n'
    const { calls, fetchImpl } = fakeFetch({
      '/dsh-restart/api/status': jsonResponse(statusPayload({
        last: { precheck: { at: '2026-11-23T03:00:00.000Z', ok: true, fingerprint: 'fp-1', failures: [], durationMs: 1200 } },
      })),
      '/dsh-restart/api/precheck': ndjsonResponse(failing),
    })
    const dialog = mountDialog(document, { fetchImpl })
    dialog.open()
    await settle()
    expect(restartButton().disabled).toBe(false)

    restartButton().click()
    await waitFor(() => noticeText().includes('预检没通过'))

    // 本轮判红：不发重启，勾选框也不会被自动勾上。
    expect(textOf('[data-dsh-restart-stage="compat"]')).toContain('未通过')
    expect(calls.some((call) => call.url === '/dsh-restart/api/restart')).toBe(false)
    expect(ackInput().checked).toBe(false)
  })

  it('检查中关掉弹窗：在飞请求被 abort、流被 cancel（M1）', async () => {
    const { response, state } = slowStream({ stage: 'config', ok: true, failures: [] })
    const { calls, fetchImpl } = fakeFetch({
      '/dsh-restart/api/status': jsonResponse(statusPayload()),
      '/dsh-restart/api/precheck': response,
    })
    const dialog = mountDialog(document, { fetchImpl })
    dialog.open()
    await settle()

    restartButton().click()
    await waitFor(() => state.reads > 0)
    const precheckCall = calls.find((call) => call.url === '/dsh-restart/api/precheck')
    expect(precheckCall?.init.signal?.aborted).toBe(false)

    dialog.close()
    await waitFor(() => state.cancelled === true)
    expect(precheckCall?.init.signal?.aborted).toBe(true)
    expect(dialogRoot()).toBeNull()
  })

  it('重启后要先见到 restarting 才判回来（M2）', async () => {
    let statusCalls = 0
    const { fetchImpl } = fakeFetch({
      // 第一次是 open 的 status；第二次模拟「旧进程还没退出」；之后才是新进程。
      '/dsh-restart/api/status': () => {
        statusCalls += 1
        if (statusCalls === 1) return jsonResponse(statusPayload({ last: {} }))
        if (statusCalls === 2) return jsonResponse(statusPayload({ restarting: true, last: {} }))
        return jsonResponse(statusPayload({ restarting: false, port: 3080, last: {} }))
      },
      '/dsh-restart/api/precheck': ndjsonResponse([
        JSON.stringify({ stage: 'config', ok: true, failures: [] }),
        JSON.stringify({ stage: 'compat', ok: true, failures: [] }),
        JSON.stringify({ stage: 'boot', ok: true, failures: [], entries: [], added: [], health: true }),
        JSON.stringify({ done: true }),
      ].join('\n') + '\n'),
      '/dsh-restart/api/restart': jsonResponse({ ok: true, at: '2026-11-23T04:00:01.000Z', port: 3080 }, 202),
    })
    const dialog = mountDialog(document, {
      fetchImpl,
      pollIntervalMs: 40,
      timeoutMs: 2000,
      // jsdom 没有真实导航：默认 reload 会打 "Not implemented" 噪声，这条用例不关心它。
      reload: () => {},
    })
    dialog.open()
    await settle()
    restartButton().click()

    await waitFor(() => statusCalls >= 2)
    // 这一包是旧进程（restarting:true），不许显示「已经回来」。
    expect(noticeText()).not.toContain('已经回来')

    // 真回来之后弹窗会关掉（见下一条用例），所以这里以「旧包没被当成回来」为准。
    expect(noticeText()).not.toContain('已经回来')
    await waitFor(() => dialogRoot() === null)
  })

  it('服务回来后关掉弹窗、刷新当前页，不叫用户自己刷（2026-11-23 反馈）', async () => {
    let statusCalls = 0
    let reloads = 0
    const { fetchImpl } = fakeFetch({
      '/dsh-restart/api/status': () => {
        statusCalls += 1
        if (statusCalls === 1) return jsonResponse(statusPayload({ last: {} }))
        if (statusCalls === 2) return jsonResponse(statusPayload({ restarting: true, last: {} }))
        return jsonResponse(statusPayload({ restarting: false, port: 3080, last: {} }))
      },
      '/dsh-restart/api/precheck': ndjsonResponse([
        JSON.stringify({ stage: 'config', ok: true, failures: [] }),
        JSON.stringify({ stage: 'compat', ok: true, failures: [] }),
        JSON.stringify({ stage: 'boot', ok: true, failures: [], entries: [], added: [], health: true }),
        JSON.stringify({ done: true }),
      ].join('\n') + '\n'),
      '/dsh-restart/api/restart': jsonResponse({ ok: true, at: '2026-11-23T04:00:01.000Z', port: 3080 }, 202),
    })
    const dialog = mountDialog(document, {
      fetchImpl,
      pollIntervalMs: 40,
      timeoutMs: 2000,
      reload: () => {
        reloads += 1
      },
    })
    dialog.open()
    await settle()
    restartButton().click()

    await waitFor(() => reloads === 1)
    // 刷新前先把弹窗收掉，页面上不留旧状态。
    expect(dialogRoot()).toBeNull()
  })

  it('NDJSON 每条 stage 到达就渲染，不等整包（M3）', async () => {
    const stream = manualNdjson()
    const { calls, fetchImpl } = fakeFetch({
      '/dsh-restart/api/status': jsonResponse(statusPayload({ last: {} })),
      '/dsh-restart/api/precheck': stream.response,
    })
    const dialog = mountDialog(document, { fetchImpl })
    dialog.open()
    await settle()
    restartButton().click()

    stream.push(JSON.stringify({ stage: 'config', ok: true, failures: [] }) + '\n')
    await waitFor(() => textOf('[data-dsh-restart-stage="config"]').includes('通过'))
    // done 还没来：不能提前宣布全过，检查中按钮锁住。
    expect(textOf('[data-dsh-restart-stage="compat"]')).toContain('未检查')
    expect(restartButton().disabled).toBe(true)

    stream.push(JSON.stringify({ stage: 'compat', ok: true, failures: [] }) + '\n')
    stream.push(JSON.stringify({ stage: 'boot', ok: true, failures: [], entries: [], added: [], health: true }) + '\n')
    stream.push(JSON.stringify({ done: true }) + '\n')
    stream.finish()
    await waitFor(() => calls.some((call) => call.url === '/dsh-restart/api/restart'))
  })

  it('最后一包多行与 done 同块、且没有结尾换行，也不丢行（m1）', async () => {
    const payload = [
      JSON.stringify({ stage: 'config', ok: true, failures: [] }),
      JSON.stringify({ stage: 'compat', ok: true, failures: [] }),
      JSON.stringify({ stage: 'boot', ok: true, failures: [], entries: [], added: [], health: true }),
      JSON.stringify({ done: true }),
    ].join('\n')
    const response: FakeResponse = {
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => payload,
      body: {
        getReader() {
          let served = false
          return {
            async read() {
              if (served) return { done: true as const, value: undefined }
              served = true
              // 唯一一包：四行挤在一起，done 与数据同块，末尾没有换行。
              return { done: true as const, value: new TextEncoder().encode(payload) }
            },
          }
        },
      },
    }
    const { calls, fetchImpl } = fakeFetch({
      '/dsh-restart/api/status': jsonResponse(statusPayload({ last: {} })),
      '/dsh-restart/api/precheck': response,
    })
    const dialog = mountDialog(document, { fetchImpl })
    dialog.open()
    await settle()
    restartButton().click()

    await waitFor(() => calls.some((call) => call.url === '/dsh-restart/api/restart'))
    expect(textOf('[data-dsh-restart-stage="boot"]')).toContain('通过')
  })
})
