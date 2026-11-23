/**
 * 账号菜单注入：在侧栏「更多」弹层的倒数第二行插一颗「重启 dsh web」。
 *
 * 为什么是 DOM 注入而不是插槽：这个入口在账号菜单的 menuitem 列里，
 * 宿主没有为「往这个菜单里加行」开插槽。所以按实机 DOM 结构补挂，
 * 并且只在「看起来是账号菜单」的 `[role="menu"]` 上动手：
 * - 菜单是 portal 到 `document.body` 的 `<div role="menu">`，每次打开都是新节点；
 * - 每行是 `<div class="_itemWrap_…">` 包一个 `<button role="menuitem">`；
 * - 弹层关掉时整棵节点被移除，所以必须用 MutationObserver 在每次重开时补挂。
 *
 * 行样式不自定义：class 直接抄相邻 menuitem，配色/尺寸/间距跟着宿主设计系统走。
 */

/** MutationObserver 的防抖窗口；React 一次重渲染会连发很多条 mutation。 */
export const DEFAULT_DEBOUNCE_MS = 100
/** 菜单行文案。 */
export const MENU_ROW_LABEL = '重启 dsh web'

const ROW_ATTR = 'data-dsh-restart-row'
const WRAP_ATTR = 'data-dsh-restart-wrap'
const LAUNCHER_ROW_ATTR = 'data-dsh-restart-launcher-row'
const ACCOUNT_MENU_LABEL = /设置|Settings|联系|Contact|退出|Sign out|登录|Sign in/

export interface InjectMenuRowOptions {
  /** 点击自建行时打开弹窗。 */
  onOpen: () => void
  /** 观察器防抖毫秒数；默认 {@link DEFAULT_DEBOUNCE_MS}，测试里调小。 */
  debounceMs?: number
}

const REFRESH_ICON =
  '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
  '<path d="M13.2 8a5.2 5.2 0 1 1-1.53-3.68" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>' +
  '<path d="M13.3 2.9v3h-3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>' +
  '</svg>'

/**
 * 幂等注入：重复调用不会出现两行；菜单每次重开都会补挂。
 * @param doc - 宿主文档（测试传 jsdom 的 document）。
 * @param opts - 点击回调与防抖配置。
 * @returns 清理函数：断开观察器、清掉定时器、移除自建行。
 */
export function injectMenuRow(doc: Document, opts: InjectMenuRowOptions): () => void {
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let observer: MutationObserver | null = null
  let started = false
  let onDomReady: (() => void) | null = null

  const clearTimer = (): void => {
    if (timer === null) return
    clearTimeout(timer)
    timer = null
  }

  const ensureRow = (): void => {
    if (disposed || doc.body === null) return
    if (injectIntoMenu(doc, opts.onOpen)) {
      // 菜单挂上了就不该再留退路那条，否则会有两个入口。
      removeLauncherRows(doc)
      return
    }
    injectIntoLauncher(doc, opts.onOpen)
  }

  const schedule = (): void => {
    if (disposed || timer !== null) return
    timer = setTimeout(() => {
      timer = null
      ensureRow()
    }, debounceMs)
  }

  const start = (): void => {
    if (disposed || started) return
    started = true
    if (doc.body === null) {
      // immediately:true 的插件可能在 body 之前加载；等 DOM 就绪再来。
      onDomReady = (): void => {
        onDomReady = null
        start()
      }
      doc.addEventListener('DOMContentLoaded', onDomReady, { once: true })
      return
    }
    ensureRow()
    const Observer = doc.defaultView?.MutationObserver ?? globalThis.MutationObserver
    if (typeof Observer === 'function') {
      observer = new Observer(schedule)
      observer.observe(doc.body, { childList: true, subtree: true })
    }
  }

  start()

  return () => {
    disposed = true
    clearTimer()
    observer?.disconnect()
    observer = null
    if (onDomReady !== null) {
      doc.removeEventListener('DOMContentLoaded', onDomReady)
      onDomReady = null
    }
    removeMenuRows(doc)
    removeLauncherRows(doc)
  }
}

/** 有账号菜单就插到最后一行的前面（= 倒数第二行）。返回是否已经处理。 */
function injectIntoMenu(doc: Document, onOpen: () => void): boolean {
  const menus = Array.from(doc.querySelectorAll('[role="menu"]')).filter(looksLikeAccountMenu)
  for (const menu of menus) {
    if (menu.querySelector('[' + ROW_ATTR + ']') !== null) return true
    const items = menuitemsOf(menu)
    const last = items[items.length - 1]
    if (last === undefined) continue
    const wrapper = last.parentElement
    const row = buildMenuRow(doc, last, onOpen)
    if (wrapper !== null && wrapper !== menu) {
      wrapper.parentElement?.insertBefore(row, wrapper)
    } else {
      last.parentElement?.insertBefore(row, last)
    }
    return true
  }
  return false
}

/** 没有菜单可插时，退到账号 launcher 上方插一条同样式的行。返回是否插入/已存在。 */
function injectIntoLauncher(doc: Document, onOpen: () => void): boolean {
  const launcher = doc.querySelector('[data-slot="settings.launcher"]')
  if (launcher === null) return false
  const parent = launcher.parentElement
  if (parent === null) return false
  // 幂等看整棵父节点：宿主可能在退路行与 launcher 之间插包裹层或分隔线，
  // 只看 previousElementSibling 会插出第二行。
  const existing = Array.from(parent.querySelectorAll('[' + LAUNCHER_ROW_ATTR + ']'))
  if (existing.length > 0) {
    for (const extra of existing.slice(1)) extra.remove()
    return true
  }

  const trigger = launcher.querySelector('button')
  const row = doc.createElement('button')
  row.type = 'button'
  row.setAttribute(LAUNCHER_ROW_ATTR, '1')
  row.setAttribute('aria-label', MENU_ROW_LABEL)
  row.title = MENU_ROW_LABEL
  if (trigger !== null) {
    row.className = trigger.className
    const collapsed = trigger.getAttribute('data-collapsed')
    if (collapsed !== null) row.setAttribute('data-collapsed', collapsed)
    const signedOut = trigger.getAttribute('data-signed-out')
    if (signedOut !== null) row.setAttribute('data-signed-out', signedOut)
  }
  const icon = doc.createElement('span')
  icon.setAttribute('aria-hidden', 'true')
  icon.innerHTML = REFRESH_ICON
  row.appendChild(icon)
  if (!row.hasAttribute('data-collapsed') || row.getAttribute('data-collapsed') !== 'true') {
    const label = doc.createElement('span')
    const sourceLabel = trigger?.querySelector('span[class]')
    if (sourceLabel !== null && sourceLabel !== undefined) label.className = sourceLabel.className
    label.textContent = MENU_ROW_LABEL
    row.appendChild(label)
  }
  row.addEventListener('click', () => onOpen())

  parent.insertBefore(row, launcher)
  return true
}

/** 只认账号菜单：排除右键/下拉菜单，并要求标签里出现「设置 / 退出」这类词。 */
function looksLikeAccountMenu(menu: Element): boolean {
  if (menu.hasAttribute('data-context-menu')) return false
  const items = menuitemsOf(menu)
  if (items.length < 2) return false
  const labels = items.map((item) => item.textContent ?? '').join(' ')
  return ACCOUNT_MENU_LABEL.test(labels)
}

function menuitemsOf(menu: Element): HTMLButtonElement[] {
  // 观察器回调里可能拿到已从文档摘除的子树（React 卸载中途），defaultView 会是 null。
  const win = menu.ownerDocument.defaultView
  if (win === null) return []
  return Array.from(menu.querySelectorAll('button[role="menuitem"]')).filter(
    (item): item is HTMLButtonElement => item instanceof win.HTMLButtonElement,
  )
}

/** 抄相邻行的 class：外面一层 itemWrap、按钮本体、图标、文字各一份。 */
function buildMenuRow(doc: Document, source: HTMLButtonElement, onOpen: () => void): Element {
  const wrapper = doc.createElement('div')
  wrapper.setAttribute(WRAP_ATTR, '1')
  const wrapClass = source.parentElement?.className ?? ''
  if (wrapClass !== '') wrapper.className = wrapClass

  const button = doc.createElement('button')
  button.type = 'button'
  button.setAttribute('role', 'menuitem')
  button.setAttribute(ROW_ATTR, '1')
  if (source.className !== '') button.className = source.className

  const icon = doc.createElement('span')
  icon.setAttribute('aria-hidden', 'true')
  const sourceIcon = source.querySelector('span[aria-hidden="true"]')
  if (sourceIcon !== null && sourceIcon.className !== '') icon.className = sourceIcon.className
  icon.innerHTML = REFRESH_ICON
  button.appendChild(icon)

  const label = doc.createElement('span')
  const labels = source.querySelectorAll('span')
  const sourceLabel = labels[labels.length - 1]
  if (sourceLabel !== undefined && sourceLabel.className !== '') label.className = sourceLabel.className
  label.textContent = MENU_ROW_LABEL
  button.appendChild(label)

  button.addEventListener('click', () => onOpen())
  wrapper.appendChild(button)
  return wrapper
}

function removeMenuRows(doc: Document): void {
  for (const row of Array.from(doc.querySelectorAll('[' + ROW_ATTR + ']'))) {
    const wrapper = row.closest('[' + WRAP_ATTR + ']')
    if (wrapper !== null) wrapper.remove()
    else row.remove()
  }
}

function removeLauncherRows(doc: Document): void {
  for (const row of Array.from(doc.querySelectorAll('[' + LAUNCHER_ROW_ATTR + ']'))) row.remove()
}
