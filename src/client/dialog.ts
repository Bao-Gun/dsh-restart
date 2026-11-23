/**
 * 重启弹窗：五段（端口 / 健康 / 模拟检查 / 重启 / 上次结果）。
 *
 * 只用原生 DOM 与 fetch，没有任何运行期依赖。所有对宿主服务端的请求都带
 * `x-dsh-restart: 1`，跟宿主路由的请求门对齐；服务端拒绝跨站请求时这里会
 * 表现为普通失败，不会静默当成功。
 *
 * 门禁规则（见 docs/superpowers/specs/2026-11-23-restart-button-design.md）：
 * - 只有「本次预检全过」或「上次预检通过且指纹没过期」才允许点重启；
 * - 不满足时按钮 disabled，旁边给一条小字退路，走 confirm() 二次确认；
 * - 重启后轮询 status，`health === true` 且拿到端口才算回来，超时转红。
 */
import type { Failure, LastRecord } from '../shared/types'
import { ensureDialogStyle } from './dialog.css'

/** 三个模拟检查阶段，顺序就是服务端 NDJSON 的顺序。 */
const STAGES = ['config', 'compat', 'boot'] as const
type Stage = (typeof STAGES)[number]

const STAGE_LABEL: Record<Stage, string> = {
  config: '配置可解析',
  compat: '插件版本兼容',
  boot: '能启动并探活',
}

const API = {
  status: '/dsh-restart/api/status',
  precheck: '/dsh-restart/api/precheck',
  restart: '/dsh-restart/api/restart',
}

/** 服务端约定：所有请求都要带这个头。 */
const REQUEST_HEADER = { 'x-dsh-restart': '1' }

const DEFAULT_POLL_INTERVAL_MS = 2000
const DEFAULT_TIMEOUT_MS = 90_000

export interface DialogRequestInit {
  method?: string
  headers?: Record<string, string>
}

/** fetch 响应的最小结构；测试里用假实现替换，不碰真实网络。 */
export interface DialogResponse {
  ok: boolean
  status: number
  json(): Promise<unknown>
  text(): Promise<string>
  body?: unknown
}

export type DialogFetch = (url: string, init: DialogRequestInit) => Promise<DialogResponse>

export interface MountDialogOptions {
  fetchImpl?: DialogFetch
  confirmImpl?: (message: string) => boolean
  /** 重启后轮询间隔，默认 2s。 */
  pollIntervalMs?: number
  /** 等 service 回来的超时，默认 90s。 */
  timeoutMs?: number
}

export interface MountedDialog {
  open(): void
  close(): void
}

export interface StatusPayload {
  ok?: boolean
  at?: string
  port?: number | null
  health?: boolean
  stale?: boolean
  fingerprint?: string | null
  restarting?: boolean
  last?: LastRecord | null
}

interface DialogView {
  root: HTMLDivElement
  port: HTMLElement
  health: HTMLElement
  last: HTMLElement
  notice: HTMLElement
  stages: Record<Stage, HTMLElement>
  failures: HTMLElement
  precheck: HTMLButtonElement
  restart: HTMLButtonElement
  force: HTMLButtonElement
  onKeydown: (event: KeyboardEvent) => void
}

/** 挂一个弹窗实例；DOM 在第一次 open 时才建，close 后整棵移除。 */
export function mountDialog(doc: Document, options: MountDialogOptions = {}): MountedDialog {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const fetchImpl = options.fetchImpl ?? defaultFetch(doc)
  const confirmImpl = options.confirmImpl ?? defaultConfirm(doc)

  let view: DialogView | null = null
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | null = null
  /** 本次打开后跑过一遍预检且全过。 */
  let localPassed = false
  /** status 里的上次预检通过且指纹没过期。 */
  let payloadPassed = false

  const stopPolling = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  const setNotice = (text: string, state: 'ok' | 'warn' | 'error' | 'none' = 'none'): void => {
    if (view === null) return
    view.notice.textContent = text
    if (state === 'none') delete view.notice.dataset.state
    else view.notice.dataset.state = state
  }

  const refreshGate = (): void => {
    if (view === null) return
    const passed = localPassed || payloadPassed
    view.restart.disabled = !passed
    // 没通过时才给退路；通过时那条小字没有意义。
    view.force.hidden = passed
  }

  const request = async (url: string, method: string): Promise<DialogResponse> => {
    return fetchImpl(url, { method, headers: { ...REQUEST_HEADER } })
  }

  const loadStatus = async (): Promise<void> => {
    if (view === null) return
    try {
      const response = await request(API.status, 'GET')
      if (!response.ok) throw new Error('HTTP ' + response.status)
      const payload = parseStatus(await response.json())
      if (view === null) return
      renderStatus(view, payload)
      payloadPassed = passedByPayload(payload)
      refreshGate()
    } catch (error) {
      if (view === null) return
      view.health.textContent = '读不到状态'
      view.last.textContent = '读不到上次结果'
      setNotice('读状态失败：' + messageOf(error) + '（宿主服务端可能没起来）', 'error')
    }
  }

  const renderStatus = (target: DialogView, payload: StatusPayload): void => {
    target.port.textContent = payload.port === null || payload.port === undefined ? '未监听' : String(payload.port)
    target.health.textContent = payload.health === true ? '正常' : '探不到 /health'
    target.last.textContent = lastText(payload)
    if (payload.restarting === true) {
      setNotice('已经有一个重启在进行中，等它回来。', 'warn')
      return
    }
    if (payload.stale === true && payload.last?.precheck !== undefined && payload.last.precheck !== null) {
      setNotice('指纹变了：上次「通过」是旧配置的结论，请重新检查。', 'warn')
    }
  }

  const appendFailure = (failure: Failure): void => {
    if (view === null) return
    const item = doc.createElement('li')
    item.className = 'dsh-restart-failure'
    item.setAttribute('data-dsh-restart-failure', '1')
    item.textContent = failureText(failure)
    view.failures.appendChild(item)
  }

  const renderStage = (stage: Stage, ok: boolean, failures: Failure[]): void => {
    if (view === null) return
    const element = view.stages[stage]
    element.dataset.state = ok ? 'ok' : 'fail'
    element.textContent = STAGE_LABEL[stage] + ' · ' + (ok ? '通过' : '未通过（' + failures.length + ' 项）')
  }

  const resetView = (target: DialogView): void => {
    target.port.textContent = '读取中…'
    target.health.textContent = '检查中…'
    target.last.textContent = '读取中…'
    target.notice.textContent = ''
    delete target.notice.dataset.state
    target.failures.textContent = ''
    for (const stage of STAGES) {
      const element = target.stages[stage]
      element.dataset.state = 'idle'
      element.textContent = STAGE_LABEL[stage] + ' · 未检查'
    }
    target.precheck.disabled = false
    target.precheck.textContent = '开始检查'
    localPassed = false
    payloadPassed = false
    refreshGate()
  }

  const runPrecheck = async (): Promise<void> => {
    if (view === null) return
    const target = view
    target.precheck.disabled = true
    target.precheck.textContent = '检查中…'
    localPassed = false
    refreshGate()
    target.failures.textContent = ''
    delete target.notice.dataset.state
    target.notice.textContent = '正在逐项检查…'

    const results: Partial<Record<Stage, boolean>> = {}
    let doneError: string | undefined
    let sawDone = false

    try {
      const response = await request(API.precheck, 'POST')
      if (!response.ok) throw new Error('HTTP ' + response.status)
      await readNdjson(response, (line) => {
        if (typeof line !== 'object' || line === null) return
        const record = line as Record<string, unknown>
        if (record.done === true) {
          sawDone = true
          if (typeof record.error === 'string') doneError = record.error
          return
        }
        const stage = record.stage
        if (stage !== 'config' && stage !== 'compat' && stage !== 'boot') return
        const ok = record.ok === true
        const failures = parseFailures(record.failures)
        results[stage] = ok
        renderStage(stage, ok, failures)
        if (!ok) failures.forEach(appendFailure)
      })

      const allOk = sawDone && STAGES.every((stage) => results[stage] === true) && doneError === undefined
      localPassed = allOk
      if (allOk) setNotice('检查全过，可以重启。', 'ok')
      else setNotice(doneError ?? '预检没全过：先按上面的失败项修，再重试。', 'error')
    } catch (error) {
      localPassed = false
      setNotice('检查失败：' + messageOf(error), 'error')
    } finally {
      if (view === target) {
        target.precheck.disabled = false
        target.precheck.textContent = '重新检查'
        refreshGate()
      }
    }
  }

  const startRestart = async (): Promise<void> => {
    if (view === null) return
    const target = view
    target.restart.disabled = true
    target.force.hidden = true
    target.precheck.disabled = true
    setNotice('正在请求重启…')

    try {
      const response = await request(API.restart, 'POST')
      if (response.status === 409) {
        setNotice('已经有一个重启在进行中，等它回来。', 'warn')
        target.precheck.disabled = false
        refreshGate()
        return
      }
      if (!response.ok) throw new Error('HTTP ' + response.status)
      setNotice('重启已发起，等服务回来…（最长 ' + Math.round(timeoutMs / 1000) + ' 秒）', 'ok')
      pollUntilBack()
    } catch (error) {
      setNotice('重启请求失败：' + messageOf(error), 'error')
      target.precheck.disabled = false
      refreshGate()
    }
  }

  const pollUntilBack = (): void => {
    stopPolling()
    const startedAt = Date.now()
    const tick = async (): Promise<void> => {
      timer = null
      if (disposed || view === null) return
      if (!view.root.isConnected) return
      try {
        const response = await request(API.status, 'GET')
        if (response.ok) {
          const payload = parseStatus(await response.json())
          if (payload.health === true && typeof payload.port === 'number') {
            setNotice('已经回来，刷新页面就能用新插件了。', 'ok')
            if (view !== null) {
              view.health.textContent = '正常'
              view.port.textContent = String(payload.port)
              view.precheck.disabled = false
            }
            return
          }
        }
      } catch {
        // dsh web 正在重启，连接被拒/超时都是预期内的，继续等。
      }
      if (Date.now() - startedAt >= timeoutMs) {
        setNotice('超时：' + Math.round(timeoutMs / 1000) + ' 秒内服务没回来。去终端看 dsh web 的日志。', 'error')
        return
      }
      timer = setTimeout(() => {
        void tick()
      }, pollIntervalMs)
    }
    timer = setTimeout(() => {
      void tick()
    }, pollIntervalMs)
  }

  const close = (): void => {
    stopPolling()
    if (view !== null) {
      doc.removeEventListener('keydown', view.onKeydown)
      view.root.remove()
      view = null
    }
  }

  const open = (): void => {
    if (disposed) return
    if (view === null) {
      view = buildDialog(doc, {
        onClose: close,
        onPrecheck: () => {
          void runPrecheck()
        },
        onRestart: () => {
          void startRestart()
        },
        onForce: () => {
          // 二次确认：默认「不重启」，避免回车误触。
          const confirmed = confirmImpl('预检没全过，直接重启可能让 dsh web 起不来。确定继续吗？')
          if (!confirmed) return
          void startRestart()
        },
      })
      ;(doc.body ?? doc.documentElement).appendChild(view.root)
    }
    view.root.hidden = false
    resetView(view)
    void loadStatus()
  }

  return {
    open,
    close,
  }
}

interface DialogHandlers {
  onClose: () => void
  onPrecheck: () => void
  onRestart: () => void
  onForce: () => void
}

/** 建 DOM。文本一律走 textContent，服务端给的失败原因不会被当成 HTML。 */
function buildDialog(doc: Document, handlers: DialogHandlers): DialogView {
  ensureDialogStyle(doc)

  const root = doc.createElement('div')
  root.className = 'dsh-restart-overlay'
  root.setAttribute('data-dsh-restart-dialog', '1')
  root.setAttribute('role', 'dialog')
  root.setAttribute('aria-modal', 'true')
  root.setAttribute('aria-labelledby', 'dsh-restart-title')

  const panel = doc.createElement('div')
  panel.className = 'dsh-restart-panel'
  root.appendChild(panel)

  const head = doc.createElement('div')
  head.className = 'dsh-restart-head'
  const title = doc.createElement('h2')
  title.className = 'dsh-restart-title'
  title.id = 'dsh-restart-title'
  title.textContent = '重启 dsh web'
  const closeButton = doc.createElement('button')
  closeButton.type = 'button'
  closeButton.className = 'dsh-restart-close'
  closeButton.setAttribute('aria-label', '关闭')
  closeButton.textContent = '×'
  closeButton.addEventListener('click', () => handlers.onClose())
  head.appendChild(title)
  head.appendChild(closeButton)
  panel.appendChild(head)

  const hint = doc.createElement('p')
  hint.className = 'dsh-restart-hint'
  hint.textContent = '装完插件看到上一次「通过」最危险：插件换了，上次结论就不作数。以本次检查为准。'
  panel.appendChild(hint)

  // ① 端口与健康
  const serviceSection = section(doc, '服务')
  const portLine = doc.createElement('div')
  portLine.className = 'dsh-restart-value'
  portLine.textContent = '端口 '
  const port = doc.createElement('span')
  port.setAttribute('data-dsh-restart-port', '1')
  port.textContent = '读取中…'
  portLine.appendChild(port)
  const healthLine = doc.createElement('div')
  healthLine.className = 'dsh-restart-value'
  healthLine.textContent = '/health '
  const health = doc.createElement('span')
  health.setAttribute('data-dsh-restart-health', '1')
  health.textContent = '检查中…'
  healthLine.appendChild(health)
  serviceSection.body.appendChild(portLine)
  serviceSection.body.appendChild(healthLine)
  panel.appendChild(serviceSection.root)

  // ② + ③ 模拟检查
  const checkSection = section(doc, '模拟检查')
  const checkHint = doc.createElement('div')
  checkHint.className = 'dsh-restart-hint'
  checkHint.textContent = '照着重启后的流程跑一遍：解析配置 → 校验插件版本 → 试启动并探活。'
  checkSection.body.appendChild(checkHint)
  const stages = {} as Record<Stage, HTMLElement>
  for (const stage of STAGES) {
    const row = doc.createElement('div')
    row.className = 'dsh-restart-stage'
    row.setAttribute('data-dsh-restart-stage', stage)
    row.dataset.state = 'idle'
    const dot = doc.createElement('span')
    dot.className = 'dsh-restart-dot'
    const text = doc.createElement('span')
    text.textContent = STAGE_LABEL[stage] + ' · 未检查'
    row.appendChild(dot)
    row.appendChild(text)
    checkSection.body.appendChild(row)
    stages[stage] = row
  }
  const failures = doc.createElement('ul')
  failures.className = 'dsh-restart-failures'
  checkSection.body.appendChild(failures)
  panel.appendChild(checkSection.root)

  // ④ 重启
  const actionSection = section(doc, '重启')
  const actions = doc.createElement('div')
  actions.className = 'dsh-restart-actions'
  const precheck = doc.createElement('button')
  precheck.type = 'button'
  precheck.className = 'dsh-restart-btn'
  precheck.setAttribute('data-dsh-restart-precheck', '1')
  precheck.textContent = '开始检查'
  precheck.addEventListener('click', () => handlers.onPrecheck())
  const restart = doc.createElement('button')
  restart.type = 'button'
  restart.className = 'dsh-restart-btn dsh-restart-btn--primary'
  restart.setAttribute('data-dsh-restart-restart', '1')
  restart.textContent = '重启 dsh web'
  restart.disabled = true
  restart.addEventListener('click', () => {
    if (restart.disabled) return
    handlers.onRestart()
  })
  actions.appendChild(precheck)
  actions.appendChild(restart)
  actionSection.body.appendChild(actions)

  const force = doc.createElement('button')
  force.type = 'button'
  force.className = 'dsh-restart-force'
  force.setAttribute('data-dsh-restart-force', '1')
  force.textContent = '我知道风险，直接重启'
  force.addEventListener('click', () => handlers.onForce())
  actionSection.body.appendChild(force)
  panel.appendChild(actionSection.root)

  // ⑤ 上次结果
  const lastSection = section(doc, '上次结果')
  const last = doc.createElement('div')
  last.className = 'dsh-restart-value'
  last.setAttribute('data-dsh-restart-last', '1')
  last.textContent = '读取中…'
  lastSection.body.appendChild(last)
  panel.appendChild(lastSection.root)

  const notice = doc.createElement('div')
  notice.className = 'dsh-restart-notice'
  notice.setAttribute('aria-live', 'polite')
  panel.appendChild(notice)

  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') handlers.onClose()
  }
  root.addEventListener('click', (event) => {
    if (event.target === root) handlers.onClose()
  })
  doc.addEventListener('keydown', onKeydown)

  return { root, port, health, last, notice, stages, failures, precheck, restart, force, onKeydown }
}

function section(doc: Document, label: string): { root: HTMLElement, body: HTMLElement } {
  const root = doc.createElement('section')
  root.className = 'dsh-restart-section'
  const caption = doc.createElement('div')
  caption.className = 'dsh-restart-label'
  caption.textContent = label
  root.appendChild(caption)
  return { root, body: root }
}

function lastText(payload: StatusPayload): string {
  const last = payload.last
  const precheck = last?.precheck
  if (precheck === undefined || precheck === null) return '还没有预检记录'
  const failures = Array.isArray(precheck.failures) ? precheck.failures.length : 0
  const head = formatTime(precheck.at) + ' 预检' + (precheck.ok === true ? '通过' : '未通过')
  const detail = failures > 0 ? ' · ' + failures + ' 项失败' : ''
  const stale = payload.stale === true ? '（已过期，需重新检查）' : ''
  return head + detail + stale
}

function passedByPayload(payload: StatusPayload): boolean {
  const precheck = payload.last?.precheck
  return precheck !== undefined && precheck !== null && precheck.ok === true && payload.stale !== true && payload.restarting !== true
}

function formatTime(at: string | undefined): string {
  if (typeof at !== 'string' || at.length < 16) return '之前'
  return at.slice(0, 16).replace('T', ' ')
}

function failureText(failure: Failure): string {
  const head = failure.plugin === undefined ? '' : failure.plugin + '：'
  const detail = failure.expected === undefined && failure.actual === undefined
    ? ''
    : '（期望 ' + (failure.expected ?? '—') + '，实际 ' + (failure.actual ?? '—') + '）'
  return '[' + failure.kind + '] ' + head + failure.message + detail
}

function parseStatus(value: unknown): StatusPayload {
  if (typeof value !== 'object' || value === null) return {}
  const record = value as Record<string, unknown>
  const last = record.last
  return {
    ok: record.ok === true,
    at: typeof record.at === 'string' ? record.at : undefined,
    port: typeof record.port === 'number' ? record.port : null,
    health: record.health === true,
    stale: record.stale === true,
    restarting: record.restarting === true,
    last: typeof last === 'object' && last !== null ? (last as LastRecord) : null,
  }
}

function parseFailures(value: unknown): Failure[] {
  if (!Array.isArray(value)) return []
  const out: Failure[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    if (typeof record.message !== 'string') continue
    const kind = record.kind === 'config' || record.kind === 'compat' || record.kind === 'boot' ? record.kind : 'config'
    out.push({
      kind,
      message: record.message,
      plugin: typeof record.plugin === 'string' ? record.plugin : undefined,
      expected: typeof record.expected === 'string' ? record.expected : undefined,
      actual: typeof record.actual === 'string' ? record.actual : undefined,
    })
  }
  return out
}

type StreamBody = {
  getReader(): { read(): Promise<{ done: boolean, value?: Uint8Array }> }
}

/**
 * 逐行解析 NDJSON。
 *
 * 优先流式读（阶段一到就画一到，用户不用干等整包），服务端只给整包文本时退回 text()。
 * 每行独立 try/catch：某一行坏了不该把已经画出来的阶段抹掉。
 */
async function readNdjson(response: DialogResponse, onLine: (line: unknown) => void): Promise<void> {
  const body = response.body as StreamBody | null | undefined
  if (body !== null && body !== undefined && typeof body.getReader === 'function') {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const chunk = await reader.read()
      if (chunk.value !== undefined && chunk.value !== null) buffer += decoder.decode(chunk.value, { stream: true })
      if (chunk.done === true) break
      buffer = drainLines(buffer, onLine)
    }
    buffer += decoder.decode()
    const tail = buffer.trim()
    if (tail !== '') emitLine(tail, onLine)
    return
  }

  const text = await response.text()
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line !== '') emitLine(line, onLine)
  }
}

/** 把 buffer 里所有完整的行喂给回调，返回剩下的半行。 */
function drainLines(buffer: string, onLine: (line: unknown) => void): string {
  let rest = buffer
  let index = rest.indexOf('\n')
  while (index !== -1) {
    const line = rest.slice(0, index).trim()
    rest = rest.slice(index + 1)
    if (line !== '') emitLine(line, onLine)
    index = rest.indexOf('\n')
  }
  return rest
}

function emitLine(line: string, onLine: (line: unknown) => void): void {
  try {
    onLine(JSON.parse(line) as unknown)
  } catch {
    // 半行或坏行：跳过，不打断后面的阶段。
  }
}

function defaultFetch(doc: Document): DialogFetch {
  const candidate = doc.defaultView?.fetch ?? globalThis.fetch
  if (typeof candidate !== 'function') return async () => { throw new Error('当前环境没有 fetch') }
  return async (url, init) => candidate.call(doc.defaultView ?? globalThis, url, init) as Promise<DialogResponse>
}

function defaultConfirm(doc: Document): (message: string) => boolean {
  return (message) => {
    const candidate = doc.defaultView?.confirm ?? globalThis.confirm
    if (typeof candidate !== 'function') return false
    return candidate.call(doc.defaultView ?? globalThis, message) === true
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
