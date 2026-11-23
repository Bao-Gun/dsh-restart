/**
 * 客户端入口：由宿主的 ClientModuleSystem 通过 window.__ModuleLoader__ 装载。
 *
 * 契约（取证见 dsh-client-modules/lib/client.js 的 ClientModuleSystem.materialize）：
 * factory 必须返回一个带 `apply` 的对象；宿主拿到它之后按插件调用 apply(ctx)。
 * 这里只做两件事：把菜单行挂上，把弹窗挂上；其余都交给宿主。
 */
import { mountDialog, type MountedDialog } from './dialog'
import { injectMenuRow } from './inject'

interface ClientContext {
  effect?: (fn: () => void | (() => void)) => unknown
}

/** 宿主可能重复 apply（热重载），全部资源要能原地替换。 */
export function apply(ctx?: ClientContext): void {
  const doc = typeof document === 'undefined' ? null : document
  if (doc === null) return

  let dialog: MountedDialog | null = null
  const openDialog = (): void => {
    if (dialog === null) dialog = mountDialog(doc)
    dialog.open()
  }

  const stopInject = injectMenuRow(doc, { onOpen: openDialog })

  const cleanup = (): void => {
    stopInject()
    dialog?.close()
    dialog = null
  }

  if (typeof ctx?.effect === 'function') ctx.effect(() => cleanup)
  else if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', cleanup, { once: true })
  }
}
