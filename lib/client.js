window.__ModuleLoader__.load({ id: "dsh-restart", factory: (require) => {
"use strict";
var __dsh_restart_client = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // src/client/index.ts
  var client_exports = {};
  __export(client_exports, {
    apply: () => apply
  });

  // src/client/dialog.css.ts
  var DIALOG_STYLE_ID = "dsh-restart-dialog-style";
  var dialogCss = `
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
  /* \u6587\u5B57\u8272\u5FC5\u987B\u8DDF\u7740\u586B\u5145\u8272\u8D70\uFF1A\u6DF1\u8272\u4E3B\u9898\u4E0B button-primary-fill \u662F\u8FD1\u767D\u8272\uFF08rgb(249,250,251)\uFF09\uFF0C
     \u5199\u6B7B #fff \u5C31\u662F\u767D\u5B57\u767D\u5E95\uFF0C\u6574\u9897\u6309\u94AE\u770B\u7740\u4E00\u5757\u767D\uFF082026-11-23 \u5B9E\u6D4B\uFF09\u3002 */
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
`;
  function ensureDialogStyle(doc) {
    if (doc.getElementById(DIALOG_STYLE_ID) !== null) return;
    const style = doc.createElement("style");
    style.id = DIALOG_STYLE_ID;
    style.textContent = dialogCss;
    (doc.head ?? doc.documentElement).appendChild(style);
  }

  // src/client/dialog.ts
  var STAGES = ["config", "compat", "boot"];
  var STAGE_LABEL = {
    config: "\u914D\u7F6E\u53EF\u89E3\u6790",
    compat: "\u63D2\u4EF6\u7248\u672C\u517C\u5BB9",
    boot: "\u80FD\u542F\u52A8\u5E76\u63A2\u6D3B"
  };
  var API = {
    status: "/dsh-restart/api/status",
    precheck: "/dsh-restart/api/precheck",
    restart: "/dsh-restart/api/restart"
  };
  var REQUEST_HEADER = { "x-dsh-restart": "1" };
  var DEFAULT_POLL_INTERVAL_MS = 2e3;
  var DEFAULT_TIMEOUT_MS = 9e4;
  function mountDialog(doc, options = {}) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const fetchImpl = options.fetchImpl ?? defaultFetch(doc);
    const reloadPage = options.reload ?? (() => {
      doc.defaultView?.location.reload();
    });
    let view = null;
    let disposed = false;
    let timer = null;
    let checking = false;
    let restarting = false;
    const inflight = /* @__PURE__ */ new Set();
    let token = 0;
    let lastFocus = null;
    const stopPolling = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };
    const setNotice = (text, state = "none", target = view) => {
      if (target === null) return;
      target.notice.textContent = text;
      if (state === "none") delete target.notice.dataset.state;
      else target.notice.dataset.state = state;
    };
    const refreshGate = () => {
      if (view === null) return;
      const busy = checking || restarting;
      view.restart.disabled = busy;
      view.ackInput.disabled = busy;
    };
    const beginRequest = () => {
      const controller = new AbortController();
      inflight.add(controller);
      return {
        signal: controller.signal,
        done: () => {
          inflight.delete(controller);
        }
      };
    };
    const abortInflight = () => {
      for (const controller of inflight) controller.abort();
      inflight.clear();
    };
    const request = async (url, method, signal) => {
      return fetchImpl(url, { method, headers: { ...REQUEST_HEADER }, signal });
    };
    const live = (target, ticket) => view === target && ticket === token;
    const loadStatus = async (target, ticket) => {
      const { signal, done } = beginRequest();
      try {
        const response = await request(API.status, "GET", signal);
        if (!response.ok) throw new Error("HTTP " + response.status);
        const payload = parseStatus(await response.json());
        if (!live(target, ticket)) return;
        renderStatus(target, payload);
        refreshGate();
      } catch (error) {
        if (!live(target, ticket) || isAbort(error)) return;
        target.health.textContent = "\u8BFB\u4E0D\u5230\u72B6\u6001";
        target.last.textContent = "\u8BFB\u4E0D\u5230\u4E0A\u6B21\u7ED3\u679C";
        setNotice("\u8BFB\u72B6\u6001\u5931\u8D25\uFF1A" + messageOf(error) + "\uFF08\u5BBF\u4E3B\u670D\u52A1\u7AEF\u53EF\u80FD\u6CA1\u8D77\u6765\uFF09", "error", target);
      } finally {
        done();
      }
    };
    const renderStatus = (target, payload) => {
      target.port.textContent = payload.port === null || payload.port === void 0 ? "\u672A\u76D1\u542C" : String(payload.port);
      target.health.textContent = payload.health === true ? "\u6B63\u5E38" : "\u63A2\u4E0D\u5230 /health";
      target.last.textContent = lastText(payload);
      if (payload.restarting === true) {
        setNotice("\u5DF2\u7ECF\u6709\u4E00\u4E2A\u91CD\u542F\u5728\u8FDB\u884C\u4E2D\uFF0C\u7B49\u5B83\u56DE\u6765\u3002", "warn", target);
        return;
      }
      if (payload.stale === true && payload.last?.precheck !== void 0 && payload.last.precheck !== null) {
        setNotice("\u6307\u7EB9\u53D8\u4E86\uFF1A\u4E0A\u6B21\u300C\u901A\u8FC7\u300D\u662F\u65E7\u914D\u7F6E\u7684\u7ED3\u8BBA\uFF0C\u8FD9\u6B21\u91CD\u542F\u4F1A\u91CD\u65B0\u68C0\u67E5\u3002", "warn", target);
      }
    };
    const appendFailure = (failure) => {
      if (view === null) return;
      const item = doc.createElement("li");
      item.className = "dsh-restart-failure";
      item.setAttribute("data-dsh-restart-failure", "1");
      item.textContent = failureText(failure);
      view.failures.appendChild(item);
    };
    const appendWarning = (failure) => {
      if (view === null) return;
      const item = doc.createElement("li");
      item.className = "dsh-restart-warning";
      item.setAttribute("data-dsh-restart-warning", "1");
      item.textContent = failureText(failure);
      view.failures.appendChild(item);
    };
    const renderStage = (stage, ok, failures, warnings = []) => {
      if (view === null) return;
      const element = view.stages[stage];
      element.dataset.state = ok ? "ok" : "fail";
      const note = warnings.length > 0 ? "\uFF08" + warnings.length + " \u6761\u63D0\u793A\uFF09" : "";
      element.textContent = STAGE_LABEL[stage] + " \xB7 " + (ok ? "\u901A\u8FC7" + note : "\u672A\u901A\u8FC7\uFF08" + failures.length + " \u9879\uFF09");
    };
    const resetView = (target) => {
      target.port.textContent = "\u8BFB\u53D6\u4E2D\u2026";
      target.health.textContent = "\u68C0\u67E5\u4E2D\u2026";
      target.last.textContent = "\u8BFB\u53D6\u4E2D\u2026";
      target.notice.textContent = "";
      delete target.notice.dataset.state;
      target.failures.textContent = "";
      for (const stage of STAGES) {
        const element = target.stages[stage];
        element.dataset.state = "idle";
        element.textContent = STAGE_LABEL[stage] + " \xB7 \u672A\u68C0\u67E5";
      }
      target.ackInput.disabled = false;
      target.ackInput.checked = false;
      checking = false;
      restarting = false;
      refreshGate();
    };
    const runPrecheck = async () => {
      if (view === null) return false;
      const target = view;
      const ticket = ++token;
      const { signal, done } = beginRequest();
      checking = true;
      refreshGate();
      target.failures.textContent = "";
      delete target.notice.dataset.state;
      target.notice.textContent = "\u6B63\u5728\u9010\u9879\u68C0\u67E5\u2026";
      const results = {};
      let doneError;
      let sawDone = false;
      let warnCount = 0;
      let failCount = 0;
      try {
        const response = await request(API.precheck, "POST", signal);
        if (response.status === 409) {
          const payload = await safeJson(response);
          throw new Error(typeof payload.error === "string" ? payload.error : "\u5DF2\u6709\u4E00\u8F6E\u9884\u68C0\u5728\u8FDB\u884C\uFF0C\u7B49\u5B83\u7ED3\u675F\u518D\u8BD5");
        }
        if (!response.ok) throw new Error("HTTP " + response.status);
        await readNdjson(response, (line) => {
          if (!live(target, ticket)) return;
          if (typeof line !== "object" || line === null) return;
          const record = line;
          if (record.done === true) {
            sawDone = true;
            if (typeof record.error === "string") doneError = record.error;
            return;
          }
          const stage = record.stage;
          if (stage !== "config" && stage !== "compat" && stage !== "boot") return;
          const ok = record.ok === true;
          const failures = parseFailures(record.failures);
          const warnings = parseFailures(record.warnings);
          warnCount += warnings.length;
          results[stage] = ok;
          renderStage(stage, ok, failures, warnings);
          if (!ok) {
            failCount += failures.length;
            failures.forEach(appendFailure);
          }
          warnings.forEach(appendWarning);
        }, signal);
        if (!live(target, ticket)) return false;
        const allOk = sawDone && STAGES.every((stage) => results[stage] === true) && doneError === void 0;
        if (allOk) {
          setNotice(warnCount > 0 ? "\u68C0\u67E5\u901A\u8FC7\uFF08" + warnCount + " \u6761\u63D0\u793A\u89C1\u4E0A\uFF09\uFF0C\u6B63\u5728\u91CD\u542F\u2026" : "\u68C0\u67E5\u901A\u8FC7\uFF0C\u6B63\u5728\u91CD\u542F\u2026", "ok", target);
          return true;
        }
        setNotice(doneError ?? "\u9884\u68C0\u6CA1\u901A\u8FC7\uFF08" + failCount + " \u9879\uFF09\uFF1A\u5148\u6309\u4E0A\u9762\u7684\u5931\u8D25\u9879\u4FEE\uFF1B\u786E\u5B9E\u8981\u73B0\u5728\u91CD\u542F\uFF0C\u52FE\u4E0A\u300C\u8DF3\u8FC7\u68C0\u67E5\u300D\u518D\u70B9\u91CD\u542F\u3002", "error", target);
        return false;
      } catch (error) {
        if (!live(target, ticket) || isAbort(error)) return false;
        setNotice("\u68C0\u67E5\u5931\u8D25\uFF1A" + messageOf(error), "error", target);
        return false;
      } finally {
        done();
        if (live(target, ticket)) {
          checking = false;
          refreshGate();
        }
      }
    };
    const clickRestart = async () => {
      if (view === null || checking || restarting) return;
      if (view.ackInput.checked) {
        await startRestart();
        return;
      }
      const passed = await runPrecheck();
      if (passed) await startRestart();
    };
    const startRestart = async () => {
      if (view === null) return;
      const target = view;
      const ticket = ++token;
      const { signal, done } = beginRequest();
      restarting = true;
      refreshGate();
      setNotice("\u6B63\u5728\u8BF7\u6C42\u91CD\u542F\u2026", "none", target);
      try {
        const response = await request(API.restart, "POST", signal);
        if (!live(target, ticket)) return;
        if (response.status === 409) {
          const payload = await safeJson(response);
          setNotice(typeof payload.error === "string" ? payload.error : "\u5DF2\u7ECF\u6709\u4E00\u4E2A\u91CD\u542F\u5728\u8FDB\u884C\u4E2D\uFF0C\u7B49\u5B83\u56DE\u6765\u3002", "warn", target);
          restarting = false;
          refreshGate();
          return;
        }
        if (!response.ok) throw new Error("HTTP " + response.status);
        setNotice("\u91CD\u542F\u5DF2\u53D1\u8D77\uFF0C\u7B49\u670D\u52A1\u56DE\u6765\u2026\uFF08\u6700\u957F " + Math.round(timeoutMs / 1e3) + " \u79D2\uFF09", "ok", target);
        pollUntilBack(target, ticket);
      } catch (error) {
        if (!live(target, ticket) || isAbort(error)) return;
        setNotice("\u91CD\u542F\u8BF7\u6C42\u5931\u8D25\uFF1A" + messageOf(error), "error", target);
        restarting = false;
        refreshGate();
      } finally {
        done();
      }
    };
    const pollUntilBack = (target, ticket) => {
      stopPolling();
      const startedAt = Date.now();
      let sawDownOrLocked = false;
      const tick = async () => {
        timer = null;
        if (!live(target, ticket) || !target.root.isConnected) return;
        const { signal, done } = beginRequest();
        try {
          const response = await request(API.status, "GET", signal);
          if (!live(target, ticket)) return;
          if (!response.ok) {
            sawDownOrLocked = true;
          } else {
            const payload = parseStatus(await response.json());
            if (!live(target, ticket)) return;
            if (payload.restarting === true) sawDownOrLocked = true;
            const back = payload.restarting !== true && payload.health === true && typeof payload.port === "number";
            if (sawDownOrLocked && back) {
              setNotice("\u5DF2\u7ECF\u56DE\u6765\uFF0C\u6B63\u5728\u5237\u65B0\u9875\u9762\u2026", "ok", target);
              target.health.textContent = "\u6B63\u5E38";
              target.port.textContent = String(payload.port);
              close();
              reloadPage();
              return;
            }
          }
        } catch (error) {
          if (isAbort(error)) return;
          sawDownOrLocked = true;
        } finally {
          done();
        }
        if (!live(target, ticket)) return;
        if (Date.now() - startedAt >= timeoutMs) {
          setNotice("\u8D85\u65F6\uFF1A" + Math.round(timeoutMs / 1e3) + " \u79D2\u5185\u670D\u52A1\u6CA1\u56DE\u6765\u3002\u53BB\u7EC8\u7AEF\u770B dsh web \u7684\u65E5\u5FD7\u3002", "error", target);
          restarting = false;
          refreshGate();
          return;
        }
        timer = setTimeout(() => {
          void tick();
        }, pollIntervalMs);
      };
      timer = setTimeout(() => {
        void tick();
      }, pollIntervalMs);
    };
    const close = () => {
      stopPolling();
      token += 1;
      abortInflight();
      if (view !== null) {
        doc.removeEventListener("keydown", view.onKeydown);
        view.root.remove();
        view = null;
      }
      if (lastFocus !== null && lastFocus.isConnected && typeof lastFocus.focus === "function") {
        ;
        lastFocus.focus();
      }
      lastFocus = null;
    };
    const open = () => {
      if (disposed) return;
      if (view === null) {
        view = buildDialog(doc, {
          onClose: close,
          onRestart: () => {
            void clickRestart();
          },
          onAckChange: () => {
            refreshGate();
          }
        });
        (doc.body ?? doc.documentElement).appendChild(view.root);
      }
      const target = view;
      lastFocus = doc.activeElement;
      target.root.hidden = false;
      resetView(target);
      abortInflight();
      const ticket = ++token;
      target.closeButton.focus();
      void loadStatus(target, ticket);
    };
    return {
      open,
      close
    };
  }
  function buildDialog(doc, handlers) {
    ensureDialogStyle(doc);
    const root = doc.createElement("div");
    root.className = "dsh-restart-overlay";
    root.setAttribute("data-dsh-restart-dialog", "1");
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-labelledby", "dsh-restart-title");
    const panel = doc.createElement("div");
    panel.className = "dsh-restart-panel";
    root.appendChild(panel);
    const head = doc.createElement("div");
    head.className = "dsh-restart-head";
    const title = doc.createElement("h2");
    title.className = "dsh-restart-title";
    title.id = "dsh-restart-title";
    title.textContent = "\u91CD\u542F";
    const closeButton = doc.createElement("button");
    closeButton.type = "button";
    closeButton.className = "dsh-restart-close";
    closeButton.setAttribute("aria-label", "\u5173\u95ED");
    closeButton.textContent = "\xD7";
    closeButton.addEventListener("click", () => handlers.onClose());
    head.appendChild(title);
    head.appendChild(closeButton);
    panel.appendChild(head);
    const serviceSection = section(doc, "\u670D\u52A1");
    const portLine = doc.createElement("div");
    portLine.className = "dsh-restart-value";
    portLine.textContent = "\u7AEF\u53E3 ";
    const port = doc.createElement("span");
    port.setAttribute("data-dsh-restart-port", "1");
    port.textContent = "\u8BFB\u53D6\u4E2D\u2026";
    portLine.appendChild(port);
    const healthLine = doc.createElement("div");
    healthLine.className = "dsh-restart-value";
    healthLine.textContent = "/health ";
    const health = doc.createElement("span");
    health.setAttribute("data-dsh-restart-health", "1");
    health.textContent = "\u68C0\u67E5\u4E2D\u2026";
    healthLine.appendChild(health);
    serviceSection.body.appendChild(portLine);
    serviceSection.body.appendChild(healthLine);
    panel.appendChild(serviceSection.root);
    const checkSection = section(doc, "\u6A21\u62DF\u68C0\u67E5");
    const checkHint = doc.createElement("div");
    checkHint.className = "dsh-restart-hint";
    checkHint.textContent = "\u70B9\u300C\u91CD\u542F\u300D\u4F1A\u7167\u7740\u91CD\u542F\u540E\u7684\u6D41\u7A0B\u8DD1\u4E00\u904D\uFF1A\u89E3\u6790\u914D\u7F6E \u2192 \u770B\u63D2\u4EF6\u7248\u672C \u2192 \u8BD5\u542F\u52A8\u5E76\u63A2\u6D3B\u3002\u53EA\u6709\u914D\u7F6E\u89E3\u6790\u4E0D\u4E86\u3001\u6216\u8BD5\u542F\u52A8\u8D77\u4E0D\u6765\u624D\u4F1A\u62E6\uFF1B\u52FE\u4E0A\u300C\u8DF3\u8FC7\u68C0\u67E5\u300D\u5C31\u76F4\u63A5\u91CD\u542F\u3002";
    checkSection.body.appendChild(checkHint);
    const stages = {};
    for (const stage of STAGES) {
      const row = doc.createElement("div");
      row.className = "dsh-restart-stage";
      row.setAttribute("data-dsh-restart-stage", stage);
      row.dataset.state = "idle";
      const dot = doc.createElement("span");
      dot.className = "dsh-restart-dot";
      const text = doc.createElement("span");
      text.textContent = STAGE_LABEL[stage] + " \xB7 \u672A\u68C0\u67E5";
      row.appendChild(dot);
      row.appendChild(text);
      checkSection.body.appendChild(row);
      stages[stage] = row;
    }
    const failures = doc.createElement("ul");
    failures.className = "dsh-restart-failures";
    checkSection.body.appendChild(failures);
    panel.appendChild(checkSection.root);
    const actionSection = section(doc, "\u91CD\u542F");
    const actions = doc.createElement("div");
    actions.className = "dsh-restart-actions";
    const restart = doc.createElement("button");
    restart.type = "button";
    restart.className = "dsh-restart-btn dsh-restart-btn--primary";
    restart.setAttribute("data-dsh-restart-restart", "1");
    restart.textContent = "\u91CD\u542F";
    restart.disabled = true;
    restart.addEventListener("click", () => {
      if (restart.disabled) return;
      handlers.onRestart();
    });
    actions.appendChild(restart);
    actionSection.body.appendChild(actions);
    const ack = doc.createElement("label");
    ack.className = "dsh-restart-ack";
    ack.setAttribute("data-dsh-restart-ack-wrap", "1");
    const ackInput = doc.createElement("input");
    ackInput.type = "checkbox";
    ackInput.name = "dsh-restart-ack";
    ackInput.autocomplete = "off";
    ackInput.setAttribute("data-dsh-restart-ack", "1");
    ackInput.addEventListener("change", () => handlers.onAckChange());
    const ackText = doc.createElement("span");
    ackText.textContent = "\u6211\u77E5\u9053\u98CE\u9669\uFF0C\u8DF3\u8FC7\u68C0\u67E5\u76F4\u63A5\u91CD\u542F";
    ack.appendChild(ackInput);
    ack.appendChild(ackText);
    actionSection.body.appendChild(ack);
    panel.appendChild(actionSection.root);
    const lastSection = section(doc, "\u4E0A\u6B21\u7ED3\u679C");
    const last = doc.createElement("div");
    last.className = "dsh-restart-value";
    last.setAttribute("data-dsh-restart-last", "1");
    last.textContent = "\u8BFB\u53D6\u4E2D\u2026";
    lastSection.body.appendChild(last);
    panel.appendChild(lastSection.root);
    const notice = doc.createElement("div");
    notice.className = "dsh-restart-notice";
    notice.setAttribute("aria-live", "polite");
    panel.appendChild(notice);
    const onKeydown = (event) => {
      if (event.key === "Escape") handlers.onClose();
    };
    root.addEventListener("click", (event) => {
      if (event.target === root) handlers.onClose();
    });
    doc.addEventListener("keydown", onKeydown);
    return { root, port, health, last, notice, stages, failures, restart, ackInput, closeButton, onKeydown };
  }
  function section(doc, label) {
    const root = doc.createElement("section");
    root.className = "dsh-restart-section";
    const caption = doc.createElement("div");
    caption.className = "dsh-restart-label";
    caption.textContent = label;
    root.appendChild(caption);
    return { root, body: root };
  }
  function lastText(payload) {
    const last = payload.last;
    const precheck = last?.precheck;
    if (precheck === void 0 || precheck === null) return "\u8FD8\u6CA1\u6709\u9884\u68C0\u8BB0\u5F55";
    const failures = Array.isArray(precheck.failures) ? precheck.failures.length : 0;
    const warnings = Array.isArray(precheck.warnings) ? precheck.warnings.length : 0;
    const head = formatTime(precheck.at) + " \u9884\u68C0" + (precheck.ok === true ? "\u901A\u8FC7" : "\u672A\u901A\u8FC7");
    const parts = [];
    if (failures > 0) parts.push(failures + " \u9879\u5931\u8D25");
    if (warnings > 0) parts.push(warnings + " \u6761\u63D0\u793A");
    const detail = parts.length > 0 ? " \xB7 " + parts.join(" / ") : "";
    const stale = payload.stale === true ? "\uFF08\u5DF2\u8FC7\u671F\uFF0C\u9700\u91CD\u65B0\u68C0\u67E5\uFF09" : "";
    return head + detail + stale;
  }
  function formatTime(at) {
    if (typeof at !== "string" || at.length < 16) return "\u4E4B\u524D";
    const date = new Date(at);
    if (Number.isNaN(date.getTime())) return "\u4E4B\u524D";
    const pad = (value) => String(value).padStart(2, "0");
    return String(date.getFullYear()) + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) + " " + pad(date.getHours()) + ":" + pad(date.getMinutes());
  }
  function failureText(failure) {
    const head = failure.plugin === void 0 ? "" : failure.plugin + "\uFF1A";
    const detail = failure.expected === void 0 && failure.actual === void 0 ? "" : "\uFF08\u671F\u671B " + (failure.expected ?? "\u2014") + "\uFF0C\u5B9E\u9645 " + (failure.actual ?? "\u2014") + "\uFF09";
    return "[" + failure.kind + "] " + head + failure.message + detail;
  }
  function parseStatus(value) {
    if (typeof value !== "object" || value === null) return {};
    const record = value;
    const last = record.last;
    return {
      ok: record.ok === true,
      at: typeof record.at === "string" ? record.at : void 0,
      port: typeof record.port === "number" ? record.port : null,
      health: record.health === true,
      stale: record.stale === true,
      restarting: record.restarting === true,
      last: typeof last === "object" && last !== null ? last : null
    };
  }
  function parseFailures(value) {
    if (!Array.isArray(value)) return [];
    const out = [];
    for (const item of value) {
      if (typeof item !== "object" || item === null) continue;
      const record = item;
      if (typeof record.message !== "string") continue;
      const kind = record.kind === "config" || record.kind === "compat" || record.kind === "boot" ? record.kind : "config";
      out.push({
        kind,
        message: record.message,
        plugin: typeof record.plugin === "string" ? record.plugin : void 0,
        expected: typeof record.expected === "string" ? record.expected : void 0,
        actual: typeof record.actual === "string" ? record.actual : void 0
      });
    }
    return out;
  }
  async function readNdjson(response, onLine, signal) {
    const body = response.body;
    if (body !== null && body !== void 0 && typeof body.getReader === "function") {
      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (; ; ) {
        if (signal?.aborted === true) {
          if (typeof reader.cancel === "function") await reader.cancel();
          return;
        }
        const chunk = await reader.read();
        if (chunk.value !== void 0 && chunk.value !== null) buffer += decoder.decode(chunk.value, { stream: true });
        buffer = drainLines(buffer, onLine);
        if (chunk.done === true) break;
      }
      buffer += decoder.decode();
      const tail = buffer.trim();
      if (tail !== "") emitLine(tail, onLine);
      return;
    }
    const text = await response.text();
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (line !== "") emitLine(line, onLine);
    }
  }
  function drainLines(buffer, onLine) {
    let rest = buffer;
    let index = rest.indexOf("\n");
    while (index !== -1) {
      const line = rest.slice(0, index).trim();
      rest = rest.slice(index + 1);
      if (line !== "") emitLine(line, onLine);
      index = rest.indexOf("\n");
    }
    return rest;
  }
  function emitLine(line, onLine) {
    try {
      onLine(JSON.parse(line));
    } catch {
    }
  }
  function defaultFetch(doc) {
    const candidate = doc.defaultView?.fetch ?? globalThis.fetch;
    if (typeof candidate !== "function") return async () => {
      throw new Error("\u5F53\u524D\u73AF\u5883\u6CA1\u6709 fetch");
    };
    return async (url, init) => candidate.call(doc.defaultView ?? globalThis, url, init);
  }
  function messageOf(error) {
    if (error instanceof Error) return error.message;
    return String(error);
  }
  function isAbort(error) {
    return typeof error === "object" && error !== null && error.name === "AbortError";
  }
  async function safeJson(response) {
    try {
      const payload = await response.json();
      return typeof payload === "object" && payload !== null ? payload : {};
    } catch {
      return {};
    }
  }

  // src/client/inject.ts
  var DEFAULT_DEBOUNCE_MS = 100;
  var MENU_ROW_LABEL = "\u91CD\u542F";
  var ROW_ATTR = "data-dsh-restart-row";
  var WRAP_ATTR = "data-dsh-restart-wrap";
  var ACCOUNT_MENU_LABEL = /设置|Settings|联系|Contact|退出|Sign out|登录|Sign in/;
  var REFRESH_ICON = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M13.2 8a5.2 5.2 0 1 1-1.53-3.68" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M13.3 2.9v3h-3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  function injectMenuRow(doc, opts) {
    const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    let disposed = false;
    let timer = null;
    let observer = null;
    let started = false;
    let onDomReady = null;
    const clearTimer = () => {
      if (timer === null) return;
      clearTimeout(timer);
      timer = null;
    };
    const ensureRow = () => {
      if (disposed || doc.body === null) return false;
      return injectIntoMenu(doc, opts.onOpen);
    };
    const menuState = () => {
      if (doc.body === null) return "none";
      const menus = Array.from(doc.querySelectorAll('[role="menu"]')).filter(looksLikeAccountMenu);
      if (menus.length === 0) return "none";
      const inserted = menus.every((menu) => menu.querySelector("[" + ROW_ATTR + "]") !== null);
      return inserted ? "ready" : "bare";
    };
    const schedule = () => {
      if (disposed || timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        ensureRow();
      }, debounceMs);
    };
    const onMutations = (records) => {
      if (disposed) return;
      const state = menuState();
      if (state === "ready") {
        schedule();
        return;
      }
      if (state === "bare" || records.some(addedLooksLikeMenu)) {
        clearTimer();
        if (!ensureRow()) schedule();
        return;
      }
      schedule();
    };
    const start = () => {
      if (disposed || started) return;
      started = true;
      if (doc.body === null) {
        onDomReady = () => {
          onDomReady = null;
          start();
        };
        doc.addEventListener("DOMContentLoaded", onDomReady, { once: true });
        return;
      }
      ensureRow();
      const Observer = doc.defaultView?.MutationObserver ?? globalThis.MutationObserver;
      if (typeof Observer === "function") {
        observer = new Observer(onMutations);
        observer.observe(doc.body, { childList: true, subtree: true });
      }
    };
    start();
    return () => {
      disposed = true;
      clearTimer();
      observer?.disconnect();
      observer = null;
      if (onDomReady !== null) {
        doc.removeEventListener("DOMContentLoaded", onDomReady);
        onDomReady = null;
      }
      removeMenuRows(doc);
    };
  }
  function injectIntoMenu(doc, onOpen) {
    const menus = Array.from(doc.querySelectorAll('[role="menu"]')).filter(looksLikeAccountMenu);
    for (const menu of menus) {
      if (menu.querySelector("[" + ROW_ATTR + "]") !== null) return true;
      const items = menuitemsOf(menu);
      const last = items[items.length - 1];
      if (last === void 0) continue;
      const shell = last.parentElement;
      if (shell === null) continue;
      const perRowShell = shell !== menu && menuitemsOf(shell).length === 1;
      const row = buildMenuRow(doc, last, onOpen, perRowShell);
      if (perRowShell && shell.parentElement !== null) shell.parentElement.insertBefore(row, shell);
      else shell.insertBefore(row, last);
      return true;
    }
    return false;
  }
  function looksLikeAccountMenu(menu) {
    if (menu.hasAttribute("data-context-menu")) return false;
    const items = menuitemsOf(menu);
    if (items.length < 2) return false;
    const labels = items.map((item) => item.textContent ?? "").join(" ");
    return ACCOUNT_MENU_LABEL.test(labels);
  }
  function menuitemsOf(menu) {
    const win = menu.ownerDocument.defaultView;
    if (win === null) return [];
    return Array.from(menu.querySelectorAll('button[role="menuitem"]')).filter(
      (item) => item instanceof win.HTMLButtonElement
    );
  }
  function buildMenuRow(doc, source, onOpen, copyShellClass) {
    const wrapper = doc.createElement("div");
    wrapper.setAttribute(WRAP_ATTR, "1");
    const wrapClass = copyShellClass ? source.parentElement?.className ?? "" : "";
    if (wrapClass !== "") wrapper.className = wrapClass;
    const button = doc.createElement("button");
    button.type = "button";
    button.setAttribute("role", "menuitem");
    button.setAttribute(ROW_ATTR, "1");
    if (source.className !== "") button.className = source.className;
    const icon = doc.createElement("span");
    icon.setAttribute("aria-hidden", "true");
    const sourceIcon = source.querySelector('span[aria-hidden="true"]');
    if (sourceIcon !== null && sourceIcon.className !== "") icon.className = sourceIcon.className;
    icon.innerHTML = REFRESH_ICON;
    button.appendChild(icon);
    const label = doc.createElement("span");
    const labels = source.querySelectorAll("span");
    const sourceLabel = labels[labels.length - 1];
    if (sourceLabel !== void 0 && sourceLabel.className !== "") label.className = sourceLabel.className;
    label.textContent = MENU_ROW_LABEL;
    button.appendChild(label);
    button.addEventListener("click", () => onOpen());
    wrapper.appendChild(button);
    return wrapper;
  }
  function addedLooksLikeMenu(record) {
    for (const node of Array.from(record.addedNodes)) {
      if (node.nodeType !== 1) continue;
      const element = node;
      if (typeof element.matches !== "function") continue;
      if (element.matches('[role="menu"]')) return true;
      if (element.querySelector('[role="menu"]') !== null) return true;
    }
    return false;
  }
  function removeMenuRows(doc) {
    for (const row of Array.from(doc.querySelectorAll("[" + ROW_ATTR + "]"))) {
      const wrapper = row.closest("[" + WRAP_ATTR + "]");
      if (wrapper !== null) wrapper.remove();
      else row.remove();
    }
  }

  // src/client/index.ts
  function apply(ctx) {
    const doc = typeof document === "undefined" ? null : document;
    if (doc === null) return;
    let dialog = null;
    const openDialog = () => {
      if (dialog === null) dialog = mountDialog(doc);
      dialog.open();
    };
    const stopInject = injectMenuRow(doc, { onOpen: openDialog });
    const cleanup = () => {
      stopInject();
      dialog?.close();
      dialog = null;
    };
    if (typeof ctx?.effect === "function") ctx.effect(() => cleanup);
    else if (typeof window !== "undefined") {
      window.addEventListener("pagehide", cleanup, { once: true });
    }
  }
  return __toCommonJS(client_exports);
})();
return __dsh_restart_client;
} });
//# sourceMappingURL=client.js.map