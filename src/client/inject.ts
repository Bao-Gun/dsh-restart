/**
 * 账号菜单注入：在侧栏「更多」弹层的倒数第二行插一颗「重启」。
 *
 * 为什么是 DOM 注入而不是插槽：这个入口在账号菜单的 menuitem 列里，
 * 宿主没有为「往这个菜单里加行」开插槽。所以按实机 DOM 结构补挂，
 * 并且只在「看起来是账号菜单」的 `[role="menu"]` 上动手：
 * - 菜单是 portal 到 `document.body` 的 `<div role="menu">`，每次打开都是新节点；
 * - 行是 `<button role="menuitem">`：有时外面包一层 `<div class="_itemWrap_…">`，
 *   有时所有行直接挂在菜单根或 `_viewport_` 下。两种都得能插，且外壳的 class 只在
 *   「那一层只包一行」时才抄——抄到菜单根/viewport 的定位 class 会变成浮层（issue #1）；
 * - 弹层关掉时整棵节点被移除，所以必须用 MutationObserver 在每次重开时补挂；
 * - 账号菜单靠「某一行整行等于 设置 / 退出登录」认，不按子串（issue #2）。
 *
 * 只往菜单里插，**不**在侧栏底部另起一行：实机上那样会和「更多」并排成两行，
 * 把「更多」挤走（2026-11-23 现场反馈）。菜单没开就没入口，这是可以接受的代价。
 *
 * 行样式不自定义：class 直接抄相邻 menuitem，配色/尺寸/间距跟着宿主设计系统走。
 */

/**
 * MutationObserver 的防抖窗口；React 一次重渲染会连发很多条 mutation。
 *
 * 只在「菜单已经在、我们的行也已经在」之后才用得上：菜单刚出现的那一次是当场插入的，
 * 不走这个窗口（否则用户会看到菜单先弹出来、行再冒出来）。
 */
export const DEFAULT_DEBOUNCE_MS = 100
/** 菜单行文案。 */
export const MENU_ROW_LABEL = '重启'

const ROW_ATTR = 'data-dsh-restart-row'
const WRAP_ATTR = 'data-dsh-restart-wrap'
/**
 * 账号菜单里认得的整行文案：只认**整行相等**，不认子串（issue #2）。
 *
 * 按子串判会把宿主里别的菜单一起认进来：DS Bot 分组标题旁的「+」菜单会把所有群名、
 * Bot 名铺成菜单行，群里有个名字带「用户登录」四个字整张菜单就被当成账号菜单。
 */
const ACCOUNT_MENU_ROWS: ReadonlySet<string> = new Set([
  '设置',
  'Settings',
  '联系我们',
  '联系',
  'Contact',
  'Contact us',
  '意见反馈',
  'Feedback',
  '退出登录',
  '退出',
  'Sign out',
  'Log out',
  '登录',
  'Sign in',
])
/** 分组标题旁「+」那类建/加菜单：永远不是账号菜单（issue #2）。 */
const NON_ACCOUNT_MENU_CLASS = 'bt-sec-add-menu'
/** 建 Bot / 建群 / 添加已有对话：见到这种行就肯定不是账号菜单。 */
const BUILDER_ROW = /^(新建|添加已有对话)/

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

  const ensureRow = (): boolean => {
    if (disposed || doc.body === null) return false
    return injectIntoMenu(doc, opts.onOpen)
  }

  /** 菜单状态：没开 / 开着但没我们的行 / 已经插好了。 */
  const menuState = (): 'none' | 'bare' | 'ready' => {
    if (doc.body === null) return 'none'
    const menus = Array.from(doc.querySelectorAll('[role="menu"]')).filter(looksLikeAccountMenu)
    if (menus.length === 0) return 'none'
    const inserted = menus.every((menu) => menu.querySelector('[' + ROW_ATTR + ']') !== null)
    return inserted ? 'ready' : 'bare'
  }

  const schedule = (): void => {
    if (disposed || timer !== null) return
    timer = setTimeout(() => {
      timer = null
      ensureRow()
    }, debounceMs)
  }

  /**
   * 菜单一出现就当场补，不等防抖窗口。
   *
   * MutationObserver 的回调跑在微任务里，抢在浏览器把这一帧画出来之前插入，用户就看不到
   * 「菜单先弹出来、我们的行再冒出来」这个过程。已经在位之后剩下的 mutation 多半是 React
   * 重渲染的噪声，才退回防抖，避免自激。
   */
  const onMutations = (records: MutationRecord[]): void => {
    if (disposed) return
    const state = menuState()
    if (state === 'ready') {
      schedule()
      return
    }
    // 菜单开着却没有我们的行：可能刚挂上来，也可能被重渲染冲掉了，都当场补回去。
    if (state === 'bare' || records.some(addedLooksLikeMenu)) {
      clearTimer()
      if (!ensureRow()) schedule()
      return
    }
    schedule()
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
      observer = new Observer(onMutations)
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
    const shell = last.parentElement
    if (shell === null) continue
    // 只在「这一层只包一行」时才抄它的 class。行的外壳可能是 _itemWrap_（一行一个），
    // 也可能根本没有、所有行直接挂在菜单根或 viewport 下（issue #1 的实机结构）：
    // 那时抄到的就是菜单根的 _list_/_portal_，position:absolute/fixed 一带，注入行
    // 立刻变成浮层压住菜单头几行。插入点也固定在最后一行所在的那一层，别跨层。
    const perRowShell = shell !== menu && menuitemsOf(shell).length === 1
    const row = buildMenuRow(doc, last, onOpen, perRowShell)
    if (perRowShell && shell.parentElement !== null) shell.parentElement.insertBefore(row, shell)
    else shell.insertBefore(row, last)
    return true
  }
  return false
}

/** 只认账号菜单：排除右键/下拉菜单，并要求某一行整行等于「设置 / 退出登录」这类文案。 */
function looksLikeAccountMenu(menu: Element): boolean {
  if (menu.hasAttribute('data-context-menu')) return false
  // 宿主自己给「+」菜单打了类名，认得就先用它挡一道。
  if (menu.closest('.' + NON_ACCOUNT_MENU_CLASS) !== null) return false
  const items = menuitemsOf(menu)
  if (items.length < 2) return false
  const labels = items.map((item) => (item.textContent ?? '').replace(/\s+/g, ' ').trim())
  // 建群那类菜单会把所有群名铺成行，某个群正好叫「设置」也不奇怪：看到建/加行就不用再看了。
  if (labels.some((label) => BUILDER_ROW.test(label))) return false
  return labels.some((label) => ACCOUNT_MENU_ROWS.has(label))
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
function buildMenuRow(
  doc: Document,
  source: HTMLButtonElement,
  onOpen: () => void,
  copyShellClass: boolean,
): Element {
  const wrapper = doc.createElement('div')
  wrapper.setAttribute(WRAP_ATTR, '1')
  const wrapClass = copyShellClass ? (source.parentElement?.className ?? '') : ''
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

/** 这一批 mutation 里是不是新挂上来一棵「看起来像菜单」的子树。 */
function addedLooksLikeMenu(record: MutationRecord): boolean {
  for (const node of Array.from(record.addedNodes)) {
    if (node.nodeType !== 1) continue
    const element = node as Element
    if (typeof element.matches !== 'function') continue
    if (element.matches('[role="menu"]')) return true
    if (element.querySelector('[role="menu"]') !== null) return true
  }
  return false
}

function removeMenuRows(doc: Document): void {
  for (const row of Array.from(doc.querySelectorAll('[' + ROW_ATTR + ']'))) {
    const wrapper = row.closest('[' + WRAP_ATTR + ']')
    if (wrapper !== null) wrapper.remove()
    else row.remove()
  }
}

