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
 * 全程不发真实网络请求：所有 fetch / confirm 都是注入的假实现。
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
      expect(items[2]?.textContent).toContain('重启 dsh web')
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

describe('injectMenuRow：找不到菜单时的退路', () => {
  beforeEach(() => {
    document.body.innerHTML = fallbackOnly()
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('退到 [data-slot="settings.launcher"] 上方插一条同样式行', () => {
    const dispose = injectMenuRow(document, { onOpen: () => undefined })
    try {
      const launcher = document.querySelector('[data-slot="settings.launcher"]')
      const row = launcher?.previousElementSibling
      expect(row?.hasAttribute('data-dsh-restart-launcher-row')).toBe(true)
      expect(row?.textContent).toBe('重启 dsh web')
      expect(row?.className).toContain('yHnPSG_trigger')
      expect(rows(document)).toHaveLength(0)
    } finally {
      dispose()
    }
  })

  it('退路同样幂等', () => {
    const disposeA = injectMenuRow(document, { onOpen: () => undefined })
    const disposeB = injectMenuRow(document, { onOpen: () => undefined })
    try {
      expect(document.querySelectorAll('[data-dsh-restart-launcher-row]')).toHaveLength(1)
    } finally {
      disposeB()
      disposeA()
    }
  })
})

/* ------------------------------------------------------------------ */
/* 弹窗                                                                */
/* ------------------------------------------------------------------ */

type FetchCall = { url: string; init: { method?: string; headers?: Record<string, string> } }

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

function precheckButton(): HTMLButtonElement {
  return document.querySelector('[data-dsh-restart-precheck]') as HTMLButtonElement
}

function restartButton(): HTMLButtonElement {
  return document.querySelector('[data-dsh-restart-restart]') as HTMLButtonElement
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
    // 上次通过且未过期：按钮可以直接点。
    expect((document.querySelector('[data-dsh-restart-restart]') as HTMLButtonElement | null)?.disabled).toBe(false)
  })

  it('指纹过期时禁用重启按钮并提示重新检查', async () => {
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
    expect((document.querySelector('[data-dsh-restart-restart]') as HTMLButtonElement | null)?.disabled).toBe(true)
  })

  it('NDJSON 逐行更新阶段文案与失败列表；未通过时禁用重启', async () => {
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

    precheckButton().click()
    await waitFor(() => precheckButton().disabled === false)

    const precheckCall = calls.find((call) => call.url === '/dsh-restart/api/precheck')
    expect(precheckCall?.init.method).toBe('POST')
    expect(precheckCall?.init.headers?.['x-dsh-restart']).toBe('1')
    expect(textOf('[data-dsh-restart-stage="config"]')).toContain('通过')
    expect(textOf('[data-dsh-restart-stage="compat"]')).toContain('未通过')
    expect(textOf('[data-dsh-restart-stage="boot"]')).toContain('通过')
    const failures = document.querySelectorAll('[data-dsh-restart-failure]')
    expect(failures).toHaveLength(1)
    expect(failures[0]?.textContent).toContain('bad-plugin')
    expect(failures[0]?.textContent).toContain('>=0.2.2')
    expect(failures[0]?.textContent).toContain('0.1.0')
    expect((document.querySelector('[data-dsh-restart-restart]') as HTMLButtonElement).disabled).toBe(true)
  })

  it('全部阶段通过后启用重启按钮', async () => {
    const lines = [
      JSON.stringify({ stage: 'config', ok: true, failures: [] }),
      JSON.stringify({ stage: 'compat', ok: true, failures: [] }),
      JSON.stringify({ stage: 'boot', ok: true, failures: [], entries: [], added: [], health: true }),
      JSON.stringify({ done: true }),
    ].join('\n') + '\n'

    const { fetchImpl } = fakeFetch({
      '/dsh-restart/api/status': jsonResponse(statusPayload({ last: {} })),
      '/dsh-restart/api/precheck': ndjsonResponse(lines, 3),
    })
    const dialog = mountDialog(document, { fetchImpl })
    dialog.open()
    await settle()
    expect((document.querySelector('[data-dsh-restart-restart]') as HTMLButtonElement).disabled).toBe(true)

    precheckButton().click()
    await waitFor(() => restartButton().disabled === false)
    expect(restartButton().disabled).toBe(false)
  })

  it('「我知道风险，直接重启」走 confirm() 二次确认', async () => {
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
    const confirmImpl = vi.fn(() => false)
    const dialog = mountDialog(document, { fetchImpl, confirmImpl })
    dialog.open()
    await settle()
    precheckButton().click()
    await waitFor(() => precheckButton().disabled === false)
    expect(document.querySelectorAll('[data-dsh-restart-failure]')).toHaveLength(1)

    ;(document.querySelector('[data-dsh-restart-force]') as HTMLButtonElement).click()
    await settle()
    expect(confirmImpl).toHaveBeenCalledTimes(1)
    expect(calls.some((call) => call.url === '/dsh-restart/api/restart')).toBe(false)

    confirmImpl.mockReturnValue(true)
    ;(document.querySelector('[data-dsh-restart-force]') as HTMLButtonElement).click()
    await settle()
    const restartCall = calls.find((call) => call.url === '/dsh-restart/api/restart')
    expect(restartCall?.init.method).toBe('POST')
    expect(restartCall?.init.headers?.['x-dsh-restart']).toBe('1')
  })
})
