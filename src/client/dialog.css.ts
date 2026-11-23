/**
 * 弹窗样式。
 *
 * 不引第三方 CSS，也不写死配色：全部走宿主的设计 token（--dsw-alias-*），
 * token 不存在时退回一套中性色，保证在旧版本前端上也不至于白底白字。
 * 选择器统一带 .dsh-restart 前缀，避免和宿主样式互相踩。
 */

export const DIALOG_STYLE_ID = 'dsh-restart-dialog-style'

export const dialogCss = `
.dsh-restart-overlay {
  position: fixed;
  inset: 0;
  z-index: 2147483000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: color-mix(in srgb, var(--dsw-alias-label-primary, #111) 28%, transparent);
  font-size: 13px;
  line-height: 1.6;
}
.dsh-restart-overlay[hidden] {
  display: none;
}
.dsh-restart-panel {
  width: min(560px, 100%);
  max-height: calc(100vh - 32px);
  overflow-y: auto;
  padding: 18px 20px 16px;
  color: var(--dsw-alias-label-primary, #111);
  background: var(--dsw-alias-bg-layer-1, #fff);
  border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1));
  border-radius: var(--dsw-radius-md, 12px);
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.18);
}
.dsh-restart-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 4px;
}
.dsh-restart-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary, #111);
}
.dsh-restart-close {
  flex: none;
  width: 24px;
  height: 24px;
  padding: 0;
  font-size: 16px;
  line-height: 1;
  color: var(--dsw-alias-label-tertiary, #888);
  background: transparent;
  border: 0;
  border-radius: 6px;
  cursor: pointer;
}
.dsh-restart-close:hover {
  color: var(--dsw-alias-label-primary, #111);
  background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.06));
}
.dsh-restart-hint {
  margin: 0 0 8px;
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary, #888);
}
.dsh-restart-section {
  padding: 10px 0;
  border-top: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.06));
}
.dsh-restart-section:first-of-type {
  border-top: 0;
}
.dsh-restart-label {
  margin-bottom: 4px;
  font-size: 12px;
  font-weight: 500;
  color: var(--dsw-alias-label-secondary, #555);
}
.dsh-restart-value {
  font-variant-numeric: tabular-nums;
  word-break: break-word;
}
.dsh-restart-stage {
  display: flex;
  gap: 8px;
  align-items: baseline;
  padding: 2px 0;
  color: var(--dsw-alias-label-secondary, #555);
}
.dsh-restart-stage[data-state='ok'] {
  color: var(--dsw-alias-label-primary, #111);
}
.dsh-restart-stage[data-state='fail'] {
  color: var(--dsw-alias-state-error-primary, #c02626);
}
.dsh-restart-stage[data-state='idle'] {
  color: var(--dsw-alias-label-tertiary, #999);
}
.dsh-restart-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--dsw-alias-border-l2, #ccc);
}
.dsh-restart-stage[data-state='ok'] .dsh-restart-dot {
  background: var(--dsw-alias-state-success-primary, #16a34a);
}
.dsh-restart-stage[data-state='fail'] .dsh-restart-dot {
  background: var(--dsw-alias-state-error-primary, #c02626);
}
.dsh-restart-failures {
  margin: 6px 0 0;
  padding: 0;
  list-style: none;
}
.dsh-restart-failure {
  margin-top: 4px;
  padding: 6px 8px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--dsw-alias-state-error-primary, #c02626);
  background: var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.03));
  border-radius: 6px;
  white-space: pre-wrap;
  word-break: break-word;
}
.dsh-restart-warning {
  margin-top: 4px;
  padding: 6px 8px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--dsw-alias-state-warning-primary, #a16207);
  background: var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.03));
  border-radius: 6px;
  white-space: pre-wrap;
  word-break: break-word;
}
.dsh-restart-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  margin-top: 10px;
}
.dsh-restart-btn {
  padding: 6px 14px;
  font-size: 13px;
  font-family: inherit;
  color: var(--dsw-alias-label-primary, #111);
  background: var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.05));
  border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1));
  border-radius: 8px;
  cursor: pointer;
}
.dsh-restart-btn:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.08));
}
.dsh-restart-btn--primary {
  /* 文字色必须跟着填充色走：深色主题下 button-primary-fill 是近白色（rgb(249,250,251)），
     写死 #fff 就是白字白底，整颗按钮看着一块白（2026-11-23 实测）。 */
  color: var(--dsw-alias-label-primary-foreground, #fff);
  background: var(--dsw-alias-button-primary-fill, #2b6cff);
  border-color: transparent;
}
.dsh-restart-btn--primary:hover:not(:disabled) {
  background: var(--dsw-alias-button-primary-hover, #1f5ae0);
}
.dsh-restart-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.dsh-restart-ack {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  font-size: 11.5px;
  color: var(--dsw-alias-label-tertiary, #999);
  cursor: pointer;
  user-select: none;
}
.dsh-restart-ack input {
  margin: 0;
  accent-color: var(--dsw-alias-state-error-primary, #c02626);
  cursor: pointer;
}
.dsh-restart-notice {
  min-height: 18px;
  margin-top: 8px;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary, #555);
}
.dsh-restart-notice[data-state='ok'] {
  color: var(--dsw-alias-state-success-primary, #16a34a);
}
.dsh-restart-notice[data-state='warn'] {
  color: var(--dsw-alias-label-secondary, #555);
}
.dsh-restart-notice[data-state='error'] {
  color: var(--dsw-alias-state-error-primary, #c02626);
}
`

/** 样式只注入一次；重复 open 不会叠加 style 节点。 */
export function ensureDialogStyle(doc: Document): void {
  if (doc.getElementById(DIALOG_STYLE_ID) !== null) return
  const style = doc.createElement('style')
  style.id = DIALOG_STYLE_ID
  style.textContent = dialogCss
  ;(doc.head ?? doc.documentElement).appendChild(style)
}
