/**
 * 重启弹窗：五段（端口 / 健康 / 模拟检查 / 重启 / 上次结果）。
 *
 * 只用原生 DOM 与 fetch，没有任何运行期依赖。所有对宿主服务端的请求都带
 * `x-dsh-restart: 1`，跟宿主路由的请求门对齐；服务端拒绝跨站请求时这里会
 * 表现为普通失败，不会静默当成功。
 *
 * 门禁规则（见 docs/superpowers/plans/2026-11-23-restart-dialog-one-button.md）：
 * - 弹窗只有一颗「重启」：没勾「跳过检查」就先 POST precheck，三段全过才自动 POST restart；
 * - 勾上「我知道风险，跳过检查直接重启」= 跳过预检，直接 POST restart（用户 2026-11-23 要求）；
 * - 检查与重启期间按钮和勾选框都 disabled，避免一边检查一边重启；
 * - 重启后轮询 status，要先见过「重启中/连不上」，再用 `health === true` 且非 restarting 判回来。
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
  /** 关弹窗/重新开跑时中止在飞请求，服务端才能收到连接关闭并停掉冒烟。 */
  signal?: AbortSignal
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
  /** 重启后轮询间隔，默认 2s。 */
  pollIntervalMs?: number
  /** 等 service 回来的超时，默认 90s。 */
  timeoutMs?: number
  /**
   * 服务回来之后怎么刷新当前页。默认 window.location.reload()；测试里替换成记账函数。
   *
   * 为什么必须刷新：新进程加载的是新插件产物，当前页面还跑着旧 bundle；不刷新等于
   * 「重启了但用户看不出任何变化」。刷新前先关掉弹窗，页面上不留旧状态。
   */
  reload?: () => void
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
  restart: HTMLButtonElement
  /** 「我知道风险，跳过检查直接重启」的勾选框；常显、默认不勾。 */
  ackInput: HTMLInputElement
  closeButton: HTMLButtonElement
  onKeydown: (event: KeyboardEvent) => void
}

/** 挂一个弹窗实例；DOM 在第一次 open 时才建，close 后整棵移除。 */
export function mountDialog(doc: Document, options: MountDialogOptions = {}): MountedDialog {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const fetchImpl = options.fetchImpl ?? defaultFetch(doc)
  const reloadPage = options.reload ?? ((): void => {
    doc.defaultView?.location.reload()
  })

  let view: DialogView | null = null
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | null = null
  /** 本轮预检正在跑：检查期间按钮与勾选框都锁住。 */
  let checking = false
  /** 重启已发出、正在等它回来：这期间同样锁住，避免连点。 */
  let restarting = false
  /** 在飞请求的中止器：close()/重新开跑时全部 abort。 */
  const inflight = new Set<AbortController>()
  /** 每次 open/close/重新开跑都 +1；旧回包对不上就整段丢弃。 */
  let token = 0
  /** 弹窗打开前的焦点，关闭时还回去。 */
  let lastFocus: Element | null = null

  const stopPolling = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  const setNotice = (text: string, state: 'ok' | 'warn' | 'error' | 'none' = 'none', target: DialogView | null = view): void => {
    if (target === null) return
    target.notice.textContent = text
    if (state === 'none') delete target.notice.dataset.state
    else target.notice.dataset.state = state
  }

  const refreshGate = (): void => {
    if (view === null) return
    // 一颗按钮、一条门禁：忙就全锁，闲就全开。跳不跳过检查由勾选框决定（见 clickRestart）。
    const busy = checking || restarting
    view.restart.disabled = busy
    view.ackInput.disabled = busy
  }

  /** 每条请求一个中止器，登记在 inflight 里，close() 时统一 abort。 */
  const beginRequest = (): { signal: AbortSignal, done: () => void } => {
    const controller = new AbortController()
    inflight.add(controller)
    return {
      signal: controller.signal,
      done: () => {
        inflight.delete(controller)
      },
    }
  }

  const abortInflight = (): void => {
    for (const controller of inflight) controller.abort()
    inflight.clear()
  }

  const request = async (url: string, method: string, signal?: AbortSignal): Promise<DialogResponse> => {
    return fetchImpl(url, { method, headers: { ...REQUEST_HEADER }, signal })
  }

  /** 弹窗关闭/重开后旧回包一律丢弃：view 换了或 token 变了都算过期。 */
  const live = (target: DialogView, ticket: number): boolean => view === target && ticket === token

  const loadStatus = async (target: DialogView, ticket: number): Promise<void> => {
    const { signal, done } = beginRequest()
    try {
      const response = await request(API.status, 'GET', signal)
      if (!response.ok) throw new Error('HTTP ' + response.status)
      const payload = parseStatus(await response.json())
      if (!live(target, ticket)) return
      renderStatus(target, payload)
      refreshGate()
    } catch (error) {
      if (!live(target, ticket) || isAbort(error)) return
      target.health.textContent = '读不到状态'
      target.last.textContent = '读不到上次结果'
      setNotice('读状态失败：' + messageOf(error) + '（宿主服务端可能没起来）', 'error', target)
    } finally {
      done()
    }
  }

  const renderStatus = (target: DialogView, payload: StatusPayload): void => {
    target.port.textContent = payload.port === null || payload.port === undefined ? '未监听' : String(payload.port)
    target.health.textContent = payload.health === true ? '正常' : '探不到 /health'
    target.last.textContent = lastText(payload)
    if (payload.restarting === true) {
      setNotice('已经有一个重启在进行中，等它回来。', 'warn', target)
      return
    }
    if (payload.stale === true && payload.last?.precheck !== undefined && payload.last.precheck !== null) {
      setNotice('指纹变了：上次「通过」是旧配置的结论，这次重启会重新检查。', 'warn', target)
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

  /** 提示项：不拦重启，只是让人看见（例如某个插件早就没激活）。 */
  const appendWarning = (failure: Failure): void => {
    if (view === null) return
    const item = doc.createElement('li')
    item.className = 'dsh-restart-warning'
    item.setAttribute('data-dsh-restart-warning', '1')
    item.textContent = failureText(failure)
    view.failures.appendChild(item)
  }

  const renderStage = (stage: Stage, ok: boolean, failures: Failure[], warnings: Failure[] = []): void => {
    if (view === null) return
    const element = view.stages[stage]
    element.dataset.state = ok ? 'ok' : 'fail'
    const note = warnings.length > 0 ? '（' + warnings.length + ' 条提示）' : ''
    element.textContent = STAGE_LABEL[stage] + ' · ' + (ok ? '通过' + note : '未通过（' + failures.length + ' 项）')
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
    target.ackInput.disabled = false
    target.ackInput.checked = false
    checking = false
    restarting = false
    refreshGate()
  }

  /** 跑一轮预检；只有「三段全过、done 到了、没报错、弹窗还活着」才返回 true。 */
  const runPrecheck = async (): Promise<boolean> => {
    if (view === null) return false
    const target = view
    const ticket = ++token
    const { signal, done } = beginRequest()
    // 检查期间按钮与勾选框都锁住，免得到处并发。
    checking = true
    refreshGate()
    target.failures.textContent = ''
    delete target.notice.dataset.state
    target.notice.textContent = '正在逐项检查…'

    const results: Partial<Record<Stage, boolean>> = {}
    let doneError: string | undefined
    let sawDone = false
    let warnCount = 0
    let failCount = 0

    try {
      const response = await request(API.precheck, 'POST', signal)
      if (response.status === 409) {
        const payload = await safeJson(response)
        throw new Error(typeof payload.error === 'string' ? payload.error : '已有一轮预检在进行，等它结束再试')
      }
      if (!response.ok) throw new Error('HTTP ' + response.status)
      await readNdjson(response, (line) => {
        if (!live(target, ticket)) return
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
        const warnings = parseFailures(record.warnings)
        warnCount += warnings.length
        results[stage] = ok
        renderStage(stage, ok, failures, warnings)
        if (!ok) {
          failCount += failures.length
          failures.forEach(appendFailure)
        }
        warnings.forEach(appendWarning)
      }, signal)

      if (!live(target, ticket)) return false
      const allOk = sawDone && STAGES.every((stage) => results[stage] === true) && doneError === undefined
      if (allOk) {
        setNotice(warnCount > 0
          ? '检查通过（' + warnCount + ' 条提示见上），正在重启…'
          : '检查通过，正在重启…', 'ok', target)
        return true
      }
      setNotice(doneError ?? '预检没通过（' + failCount + ' 项）：先按上面的失败项修；确实要现在重启，勾上「跳过检查」再点重启。', 'error', target)
      return false
    } catch (error) {
      if (!live(target, ticket) || isAbort(error)) return false
      setNotice('检查失败：' + messageOf(error), 'error', target)
      return false
    } finally {
      done()
      if (live(target, ticket)) {
        checking = false
        refreshGate()
      }
    }
  }

  /** 一颗按钮的编排：不勾跳过检查就先预检，全过才真重启。 */
  const clickRestart = async (): Promise<void> => {
    if (view === null || checking || restarting) return
    if (view.ackInput.checked) {
      await startRestart()
      return
    }
    const passed = await runPrecheck()
    if (passed) await startRestart()
  }

  const startRestart = async (): Promise<void> => {
    if (view === null) return
    const target = view
    const ticket = ++token
    const { signal, done } = beginRequest()
    restarting = true
    refreshGate()
    setNotice('正在请求重启…', 'none', target)

    try {
      const response = await request(API.restart, 'POST', signal)
      if (!live(target, ticket)) return
      if (response.status === 409) {
        const payload = await safeJson(response)
        setNotice(typeof payload.error === 'string' ? payload.error : '已经有一个重启在进行中，等它回来。', 'warn', target)
        restarting = false
        refreshGate()
        return
      }
      if (!response.ok) throw new Error('HTTP ' + response.status)
      setNotice('重启已发起，等服务回来…（最长 ' + Math.round(timeoutMs / 1000) + ' 秒）', 'ok', target)
      pollUntilBack(target, ticket)
    } catch (error) {
      if (!live(target, ticket) || isAbort(error)) return
      setNotice('重启请求失败：' + messageOf(error), 'error', target)
      restarting = false
      refreshGate()
    } finally {
      done()
    }
  }

  /**
   * 轮询等服务回来。
   *
   * 只认 `health === true && port 是数字` 不够：helper 还没把旧进程干掉时，旧进程会照常回
   * 200 + health:true，客户端就会误报「已经回来」。所以必须先见过「重启中」（restarting）
   * 或「连不上」，才把后面的健康响应当成新进程。
   */
  const pollUntilBack = (target: DialogView, ticket: number): void => {
    stopPolling()
    const startedAt = Date.now()
    let sawDownOrLocked = false
    const tick = async (): Promise<void> => {
      timer = null
      if (!live(target, ticket) || !target.root.isConnected) return
      const { signal, done } = beginRequest()
      try {
        const response = await request(API.status, 'GET', signal)
        if (!live(target, ticket)) return
        if (!response.ok) {
          sawDownOrLocked = true
        } else {
          const payload = parseStatus(await response.json())
          if (!live(target, ticket)) return
          if (payload.restarting === true) sawDownOrLocked = true
          const back = payload.restarting !== true && payload.health === true && typeof payload.port === 'number'
          if (sawDownOrLocked && back) {
            setNotice('已经回来，正在刷新页面…', 'ok', target)
            target.health.textContent = '正常'
            target.port.textContent = String(payload.port)
            // 先关弹窗再刷新：close() 会停掉轮询、放弃在飞请求，页面重载前不留悬挂状态。
            close()
            reloadPage()
            return
          }
        }
      } catch (error) {
        if (isAbort(error)) return
        // dsh web 正在重启，连接被拒/超时都是预期内的，继续等。
        sawDownOrLocked = true
      } finally {
        done()
      }
      if (!live(target, ticket)) return
      if (Date.now() - startedAt >= timeoutMs) {
        setNotice('超时：' + Math.round(timeoutMs / 1000) + ' 秒内服务没回来。去终端看 dsh web 的日志。', 'error', target)
        // 超时别把弹窗锁死：还能重新点、重新判断。
        restarting = false
        refreshGate()
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
    // 关掉就放弃在飞请求：服务端要收到连接关闭才会中止冒烟、不写 last.json。
    token += 1
    abortInflight()
    if (view !== null) {
      doc.removeEventListener('keydown', view.onKeydown)
      view.root.remove()
      view = null
    }
    if (lastFocus !== null && lastFocus.isConnected && typeof (lastFocus as HTMLElement).focus === 'function') {
      ;(lastFocus as HTMLElement).focus()
    }
    lastFocus = null
  }

  const open = (): void => {
    if (disposed) return
    if (view === null) {
      view = buildDialog(doc, {
        onClose: close,
        onRestart: () => {
          void clickRestart()
        },
        onAckChange: () => {
          refreshGate()
        },
      })
      ;(doc.body ?? doc.documentElement).appendChild(view.root)
    }
    const target = view
    lastFocus = doc.activeElement
    target.root.hidden = false
    resetView(target)
    // 上一次打开遗留的请求（没走 close 的情况）一并放弃。
    abortInflight()
    const ticket = ++token
    target.closeButton.focus()
    void loadStatus(target, ticket)
  }

  return {
    open,
    close,
  }
}

interface DialogHandlers {
  onClose: () => void
  /** 唯一入口：跳不跳过检查由 clickRestart 按勾选状态决定。 */
  onRestart: () => void
  /** 勾选框状态变了：重新算一次门禁。 */
  onAckChange: () => void
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
  title.textContent = '重启'
  const closeButton = doc.createElement('button')
  closeButton.type = 'button'
  closeButton.className = 'dsh-restart-close'
  closeButton.setAttribute('aria-label', '关闭')
  closeButton.textContent = '×'
  closeButton.addEventListener('click', () => handlers.onClose())
  head.appendChild(title)
  head.appendChild(closeButton)
  panel.appendChild(head)

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
  checkHint.textContent = '点「重启」会照着重启后的流程跑一遍：解析配置 → 看插件版本 → 试启动并探活。只有配置解析不了、或试启动起不来才会拦；勾上「跳过检查」就直接重启。'
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
  const restart = doc.createElement('button')
  restart.type = 'button'
  restart.className = 'dsh-restart-btn dsh-restart-btn--primary'
  restart.setAttribute('data-dsh-restart-restart', '1')
  restart.textContent = '重启'
  restart.disabled = true
  restart.addEventListener('click', () => {
    if (restart.disabled) return
    handlers.onRestart()
  })
  actions.appendChild(restart)
  actionSection.body.appendChild(actions)

  // 常显、默认不勾：勾上就等于认下风险，点「重启」直接跳过检查（不弹二次确认）。
  const ack = doc.createElement('label')
  ack.className = 'dsh-restart-ack'
  ack.setAttribute('data-dsh-restart-ack-wrap', '1')
  const ackInput = doc.createElement('input')
  ackInput.type = 'checkbox'
  ackInput.name = 'dsh-restart-ack'
  ackInput.autocomplete = 'off'
  ackInput.setAttribute('data-dsh-restart-ack', '1')
  ackInput.addEventListener('change', () => handlers.onAckChange())
  const ackText = doc.createElement('span')
  ackText.textContent = '我知道风险，跳过检查直接重启'
  ack.appendChild(ackInput)
  ack.appendChild(ackText)
  actionSection.body.appendChild(ack)
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

  return { root, port, health, last, notice, stages, failures, restart, ackInput, closeButton, onKeydown }
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
  const warnings = Array.isArray(precheck.warnings) ? precheck.warnings.length : 0
  const head = formatTime(precheck.at) + ' 预检' + (precheck.ok === true ? '通过' : '未通过')
  const parts: string[] = []
  if (failures > 0) parts.push(failures + ' 项失败')
  if (warnings > 0) parts.push(warnings + ' 条提示')
  const detail = parts.length > 0 ? ' · ' + parts.join(' / ') : ''
  const stale = payload.stale === true ? '（已过期，需重新检查）' : ''
  return head + detail + stale
}

/** 落盘的 `at` 是 UTC ISO（服务端 `toISOString()`）；这里必须转成本机时区再显示。 */
function formatTime(at: string | undefined): string {
  if (typeof at !== 'string' || at.length < 16) return '之前'
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return '之前'
  const pad = (value: number): string => String(value).padStart(2, '0')
  return String(date.getFullYear()) + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
    + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
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
  getReader(): {
    read(): Promise<{ done: boolean, value?: Uint8Array }>
    cancel?(): Promise<void>
  }
}

/**
 * 逐行解析 NDJSON。
 *
 * 优先流式读（阶段一到就画一到，用户不用干等整包），服务端只给整包文本时退回 text()。
 * 每行独立 try/catch：某一行坏了不该把已经画出来的阶段抹掉。
 */
async function readNdjson(
  response: DialogResponse,
  onLine: (line: unknown) => void,
  signal?: AbortSignal,
): Promise<void> {
  const body = response.body as StreamBody | null | undefined
  if (body !== null && body !== undefined && typeof body.getReader === 'function') {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      if (signal?.aborted === true) {
        // 弹窗关了：主动放掉这条流，别让服务端以为客户端还在等。
        if (typeof reader.cancel === 'function') await reader.cancel()
        return
      }
      const chunk = await reader.read()
      if (chunk.value !== undefined && chunk.value !== null) buffer += decoder.decode(chunk.value, { stream: true })
      // 先 drain 再判 done：最后一包里可能挤着两行，done 也可能和数据同块。
      buffer = drainLines(buffer, onLine)
      if (chunk.done === true) break
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

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** abort 是关弹窗的正常路径，不该被当成「检查失败」画到界面上。 */
function isAbort(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError'
}

/** 读响应体里的 error 文案（409 这类），读不出来就当空对象。 */
async function safeJson(response: DialogResponse): Promise<Record<string, unknown>> {
  try {
    const payload = await response.json()
    return typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}
