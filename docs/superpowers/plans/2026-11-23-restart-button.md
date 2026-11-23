# 重启按钮 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在侧栏「更多」菜单倒数第二行加一颗「重启 dsh web」，点开先跑三段预检、通过后再重启。

**Architecture:** 一个 cordis 插件，宿主半边向 `ctx.webServer` 挂三条 `/dsh-restart/api/*` 路由（读状态、跑预检、触发重启），预检分快检与冒烟两段，冒烟克隆当前 profile 另起一个实例验证；浏览器半边是一段自包含的 DOM 脚本，往账号菜单弹层里插行并渲染弹窗。重启由脱离本进程的 helper 执行。

**Tech Stack:** TypeScript（ESM）、tsup（两个入口：宿主与客户端）、vitest + jsdom、Node 的 `node:http`/`node:child_process`、宿主已装的 `@deepseek-ai/dsh-host-webserver` 与 `dsh-app-boot`。无运行期第三方依赖。

**Spec:** `docs/superpowers/specs/2026-11-23-restart-button-design.md`

## Global Constraints

- Node 22+，输出全部 ESM，包名 `dsh-restart`。
- 运行期不引入第三方依赖；能用宿主包就直接 import（`@deepseek-ai/dsh-app-boot`、`@deepseek-ai/schemastery`）。
- 预检全程不写 `~/.dsh/profiles/web`；插件自己的写盘只有 `~/.dsh/dsh-restart/`。
- 三条路由都必须先过 `Reflect.get(ctx,'connection').requestRejection(req)`，并且要求请求头 `x-dsh-restart: 1`。
- 客户端半边必须是构建产物 `lib/client.js`（宿主不编 TS），且不依赖 React——纯 DOM。
- 所有落盘 JSON 先写 `<name>.tmp` 再 `rename`，读失败一律当空对象，不抛。
- 时间戳一律 UTC ISO 字符串。

## Review Focus

1. 账号菜单是弹层，每次开关都重渲染——注入的行被冲掉或插了两次。
2. 试跑实例与线上抢 18787 / 18887 这类固定端口——插件「跑不起来」导致假红，按钮被灰禁。
3. 重启后进程没回来——页面白屏，用户不知道该等还是该手动起。
4. 连点两次重启——两个实例抢同一个端口，起来的是谁说不清。
5. `last.json` 写到一半进程被杀——弹窗读它的时候崩掉。

---

### Task 1: 构建链与仓库骨架

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`, `src/shared/version.ts`
- Modify: `.gitignore`, `check.sh`（第 ④ 段换成 `pnpm test`）
- Test: `test/version.test.ts`, `test/client-artifact.test.ts`

**Interfaces:**
- Produces: `parseRuntime(version: string): { major: number; minor: number; patch: number; pre: string | null }` —— 后面判兼容要用；非法输入按宿主 `runtimeVersionOf` 同语义抛错，不返回 NaN。

- [x] **Step 1: 写失败测试** `test/version.test.ts`：`0.2.2-rc.5` 拆出 `{major:0,minor:2,patch:2,pre:'rc.5'}`；合法正式版 `pre` 为 `null`；补 `v` 前缀与 `+build` 元数据；非法输入（`''`/`0.2`/`abc`/`1.x.0`/`1.0.0-`）抛错。
- [x] **Step 2: 跑 `pnpm test`，确认失败**（模块不存在；宽松解析对非法输入不抛）。
- [x] **Step 3: 建骨架**：`package.json` 带 `"type":"module"`、`exports { ".": "./lib/index.js", "./client": "./lib/client.js" }`、`dsh.client = { platform: "web", immediately: true }`、`engines.dsh = ">=0.2.2-rc.5"`（`dsh.engines.dsh` 同值镜像）；脚本 `build: rm -rf lib && tsup` / `test: vitest run`。
- [x] **Step 3.5: tsup 拆两份配置**：宿主 `format: ['esm']` / `platform: 'node'` / `external: [/^@deepseek-ai\//]`（宿主包不内联）；客户端 `format: ['iife']` / `platform: 'browser'` / banner+footer 包成 `window.__ModuleLoader__.load({ id: "dsh-restart", factory })`，模块体延迟到 materialize 执行。`test/client-artifact.test.ts` 读真实 `lib/client.js` 验证首行注册与 factory 返回值。
- [x] **Step 4: 跑 `pnpm build`**，确认 `lib/index.js`（ESM）与 `lib/client.js`（iife，首行自注册）都生成。
- [x] **Step 5:** `.gitignore` 加 `/lib/`、`node_modules/`；`check.sh` 第 ④ 段改成 `pnpm test`。
- [x] **Step 6: 跑 `bash check.sh`**：第 ④ 段通过；第 ② 段仍红，因为本计划后续任务的文件还没创建（非 Task 1 引入，见 `reports/task-1.md`）。
- [x] **Step 7: Commit** `feat: 构建链与版本解析`；评审修复轮 `fix: 客户端产物按宿主契约注册 + 严格版本解析`

### Task 2: 指纹与上次结果

**Files:**
- Create: `src/server/last.ts`, `src/shared/types.ts`
- Test: `test/last.test.ts`

**Interfaces:**
- Produces: `computeFingerprint(profileDir: string, dshVersion: string | null): Promise<string | null>`（sha256，含 `pnpm-lock.yaml` 内容与 dsh 版本，取前 16 位；lock 读不到或版本取不到时返回 null，不抛）；`readLast(dir: string): Promise<LastRecord>`；`writeLast(dir: string, patch: Partial<LastRecord>): Promise<void>`；`isStale(rec: LastRecord, fingerprint: string | null): boolean`（当前指纹为 null 也算过期）。
- Types: `LastRecord { fingerprint?: string; baseline?: string[]; precheck?: PrecheckResult; restart?: RestartRecord }`（`baseline` 是上一次**通过**时试跑出来的未激活名单，Task 6 拿它做差分）、`PrecheckResult { at: string; ok: boolean; fingerprint: string; failures: Failure[]; durationMs: number }`、`Failure { plugin?: string; kind: 'config' 'compat' 'boot'; message: string; expected?: string; actual?: string }`、`RestartRecord { at: string; port: number }`。

- [x] **Step 1: 写失败测试**：`isStale({fingerprint:'a'},'b')` 为 `true`；`isStale({}, 'b')` 为 `true`；`readLast` 读一个只写了半截 `{` 的文件返回 `{}` 不抛；`writeLast` 后 `readLast` 能读回。
- [x] **Step 2: 跑测试，确认失败。**
- [x] **Step 3: 实现三个函数**，写盘走 `.tmp` + `rename`，`readLast` 用 try/catch 吞掉 JSON 解析错误。
- [x] **Step 4: 跑测试，确认通过。**
- [x] **Step 5: Commit** `feat: 指纹与 last.json`

### Task 3: 兼容性快检

**Files:**
- Create: `src/server/compat.ts`
- Test: `test/compat.test.ts`

**Interfaces:**
- Consumes: `parseRuntime`（Task 1）；宿主 `evaluatePluginCompatibility` / `getDshRuntimeVersion`（`@deepseek-ai/dsh-app-boot`）。
- Produces: `readInstalled(profileDir: string, options?: { onWarning?: (f: Failure) => void }): Promise<InstalledPlugin[]>`（`{ id, name, version, enginesDsh?: string, peerDsh?: string, peerDependencies?: Record<string, string>, manifestProblems?: ManifestProblem[] }`；`peerDependencies` 是完整的 dsh-* peer 集合，只留 `peerDsh` 会漏判 `@deepseek-ai/dsh-tools` 这类 peer；`manifestProblems` 是形状不合规的清单字段，有值时直接判失败）；`compatFailures(plugins: InstalledPlugin[], runtimeVersion: string): Failure[]`；`hostCompatibility()`（取宿主那两个函数，失败返回 `null`）、`hostRuntimeVersion(): string`（失败返回空串）。

- [x] **Step 1: 写失败测试**：`enginesDsh='>=0.3.0'` 配 `'0.2.2-rc.5'` 产出一条 `{kind:'compat', plugin:'x'}` 且 `expected==='>=0.3.0'`；`'*'` 与缺省（有 dsh peer 依赖）各产出 0 条与按 peer 判定的一条。另覆盖：空/非法运行时版本明确失败（不是 0 条）、坏清单只影响自己那一条、`readInstalled` 的 fixture（依赖 + 只挂 patch 的条目 + patch 里的模型行）。
- [x] **Step 2: 跑测试，确认失败。**
- [x] **Step 3: 实现**，判定一律调用宿主的 `evaluatePluginCompatibility`，不自己写版本比较。宿主包不静态 import 也不打包（profile 的 node_modules 里没有它，打包又会让 `getDshRuntimeVersion` 读回本插件的 version），改为按运行时入口定位 dsh 安装根、从那里 `createRequire`；定位/加载失败或版本非法都判失败，绝不默认放行。清单里 `engines` / `peerDependencies` 的形状不合规（宿主 `objectOf` / 字段类型检查会抛错并停用插件的那些）同样产出明确 failure，不当成「没有要求」；只挂在 patch 里的第三方条目装不上时留一条 warning，官方内置包保持安静。
- [x] **Step 4: 跑测试，确认通过。**
- [x] **Step 5: Commit** `feat: 兼容性快检`

### Task 4: 配置合成、冒烟与基线差分

**Files:**
- Create: `src/server/smoke.ts`
- Test: `test/smoke.test.ts`

**Interfaces:**
- Consumes: `Failure`（Task 2）。
- `runSmoke` 的 `ok` 只表示 /health 200；是否算「通过」由 Task 6 结合基线差分决定。
- Produces: `parseNotActivated(stderr: string): string[]`；`diffFailedEntries(current: string[], baseline: string[]): { added: string[]; removed: string[] }`；`runDumpConfig(profileDir: string): Promise<Failure[]>`；`runSmoke(opts: { profileDir: string; tmpRoot: string; timeoutMs?: number }): Promise<{ ok: boolean; failures: Failure[]; failedEntries: string[]; durationMs: number }>`。

- [x] **Step 1: 写失败测试**：`parseNotActivated` 从三行样本 stderr 里抽出两个条目名、忽略别的 warning；`diffFailedEntries(['a','b'],['b'])` 等于 `{added:['a'],removed:[]}`。
- [x] **Step 2: 跑测试，确认失败。**
- [x] **Step 3: 实现纯函数部分**（解析与差分）。冒烟本体同步写：`cp -c -R` 克隆（失败退 `cp -R`）到 `tmpRoot`，`spawn('dsh', ['--profile','web','--port','0','--no-open'])` 带 `DSH_HOME=tmp`，轮询 `http://127.0.0.1:<port>/health` 直到 200 或超时，收 stderr，`finally` 里杀进程树并删目录。
- [x] **Step 4: 跑测试，确认通过**（单测只覆盖纯函数，真起进程归手工验收）。
- [x] **Step 5: Commit** `feat: 冒烟与基线差分`
- [x] **Step 6: 真冒烟一次**：对 `~/.dsh/profiles/web` 实跑，`ok=true`、`failedEntries=[]`、`durationMs=12766ms`；进程组与临时目录已清理。

### Task 5: 重启 helper

**Files:**
- Create: `src/server/restart.ts`, `src/helper/restart.ts`（第三个入口，构建为 `lib/helper.js`）
- Modify: `tsup.config.ts`（加 helper 入口）
- Test: `test/restart.test.ts`

**Interfaces:**
- Produces: `waitForPort(port: number, timeoutMs: number, probe?: (port: number) => Promise<boolean>): Promise<boolean>`；`pickRoute(daemonInstalled: boolean, paused: boolean): 'daemon' | 'helper'`；`isRefused(lockPath: string): Promise<boolean>`；`scheduleRestart(opts: { port: number; profileDir: string; logDir: string; dshHome?: string; profileName?: string; dshBin?: string }): void`（`spawn(process.execPath, [helperPath], { detached: true, stdio: 'ignore' }).unref()`）；`runRestartHelper(opts: { port: number; profileDir: string; waitMs?: number; dshHome?: string; profileName?: string; dshBin?: string; pluginGraceMs?: number }): Promise<0 | 1>`。插件宽限取值顺序：`deps.pluginGraceMs ?? opts.pluginGraceMs ?? 5s`（helper 从 `DSH_RESTART_PLUGIN_GRACE_MS` 解析后走 opts，env 必须真的生效）；helper 的 start 行记录 `home=… profile=… source=explicit|derived`，便于事后区分显式入参与反推值。

- [x] **Step 1: 写失败测试**：`pickRoute(false,false)==='helper'`、`pickRoute(true,true)==='helper'`、`pickRoute(true,false)==='daemon'`；已有 lock 文件时 `isRefused` 为 `true`；`waitForPort(port, 200, fakeFetch)` 在探活一直失败时返回 `false` 且耗时不超过上界。
- [x] **Step 2: 跑测试，确认失败。**
- [x] **Step 3: 实现**。helper 流程：拿 lock → `spawn('dsh-daemon',['restart'])` 并轮询端口至上界（默认 60s）→ 端口没回来则 `spawn('dsh',['--profile','web','--port',String(port),'--no-open'],{detached:true, env:{...process.env, DSH_DAEMON_OPEN_BROWSER:'0'}})`（profile 只能用一种写法：位置参数 `web` 和 `--profile web` 同时出现会被 dsh 拒绝）→ 全程写 `~/.dsh/dsh-restart/helper-<ts>.log` → 释放 lock。成功判据是两段：`/health` 200 之后，`GET /dsh-restart/api/status` 也 200 才算回来；第二段超时报「插件未加载」。profile 名 / DSH_HOME / dsh 路径由调用方显式传入（写进 `DSH_RESTART_PROFILE_NAME` / `DSH_RESTART_DSH_HOME` / `DSH_RESTART_DSH_BIN`），缺参才从 `profileDir` 反推。
- [x] **Step 4: 跑测试，确认通过。**
- [x] **Step 5: Commit** `feat: 重启 helper（daemon 优先，自拉起兜底）`

### Task 6: 三条路由与鉴权

**Files:**
- Create: `src/index.ts`
- Test: `test/routes.test.ts`

**Interfaces:**
- Consumes: Task 2/3/4/5 的全部导出。
- Produces: 插件导出 `{ name: 'dsh-restart', inject: ['webServer'], apply, Config }`；`isAllowed(input: { method: string; headers: Record<string,string|undefined>; rejection?: number }): boolean`。

- [x] **Step 1: 写失败测试**：`isAllowed` 在 `rejection=403` 时 false；无 `x-dsh-restart` 头 false；`GET` 打 `/restart` false；三项齐全 true。
- [x] **Step 2: 跑测试，确认失败。**
- [x] **Step 3: 实现**：`apply(ctx)` 里用 `ctx.effect(() => ctx.webServer.register({kind:'exact', path, handler}), label)` 注册 `GET /dsh-restart/api/status`（端口取 `ctx.webServer.port`、探 `/health`、读 `last` 并算 `stale`）、`POST /dsh-restart/api/precheck`（NDJSON：每阶段一行 `{"stage":...,"ok":...,"failures":[...]}`，结尾一行 `{"done":true}`，收尾按 `diffFailedEntries(本次未激活名单, last.baseline ?? [])` 判 `ok = health200 && added.length === 0`，通过时 `writeLast({ precheck, baseline: 本次名单, fingerprint: fp })`（fp 来自 `computeFingerprint`；fp 为 null 时不写 precheck，直接判过期），不通过只写 `precheck`、不动基线）、`POST /dsh-restart/api/restart`（先 `202` 落盘，再 `setTimeout(() => scheduleRestart(...), 300)`）。
- [x] **Step 4: 跑测试，确认通过。**
- [x] **Step 5: Commit** `feat: 宿主路由与请求门`

### Task 7: 客户端注入与弹窗

**Files:**
- Create: `src/client/index.ts`, `src/client/inject.ts`, `src/client/dialog.ts`, `src/client/dialog.css.ts`（样式以字符串导出，构建时内联成 `<style>`）
- Test: `test/inject.test.ts`

**Interfaces:**
- Consumes: `GET /dsh-restart/api/status`、`POST /dsh-restart/api/precheck`、`POST /dsh-restart/api/restart`（Task 6）。
- Produces: `injectMenuRow(doc: Document, opts: { onOpen: () => void; debounceMs?: number }): () => void`（返回清理函数）；`mountDialog(doc: Document, opts?: { fetchImpl?; confirmImpl?; pollIntervalMs?; timeoutMs? }): { open(): void; close(): void }`（options 只为测试注入假 fetch/confirm，生产调用不传）。

- [x] **Step 1: 写失败测试**（`environment: 'jsdom'`，`test/inject.test.ts`，14 例）：给一段含 `role="menu"` 与三个 `role="menuitem"` 的 DOM，`injectMenuRow` 后自建的行位于倒数第二；同一 DOM 再调一次不出现两行；删掉自建行后触发 MutationObserver，行被补回；整棵弹层换掉后补回；退路锚点、点击回调、cleanup、弹窗五段与门禁全部覆盖。
- [x] **Step 2: 跑测试，确认失败**（RED：vitest 报 `Failed to resolve import`，指向当时还不存在的 `src/client/inject.ts`，0 test）。
- [x] **Step 3: 实现注入**：`MutationObserver(document.body, { childList: true, subtree: true })` + 100ms 防抖；行样式复制相邻 menuitem 的 class；锚点优先 `[role="menu"]`（排除 `data-context-menu`，且标签里要有「设置/退出」这类词），找不到则退到 `[data-slot="settings.launcher"]` 上方插一条同样式行；菜单出现后自动移除退路那条，避免两个入口。
- [x] **Step 4: 跑测试，确认通过**（`pnpm vitest run test/inject.test.ts` 14 passed）。
- [x] **Step 5: 实现弹窗**：原生 DOM，按设计稿五段（端口 / 健康 / 模拟检查 / 重启 / 上次结果）；流式读 NDJSON 更新阶段文案（`TextDecoder` 按行缓冲，不整包等）；未通过时按钮 `disabled`，下方小字「我知道风险，直接重启」触发 `confirm()`；重启后每 2s 轮询 `status`，90s 超时转红；样式只注入一次（`ensureDialogStyle`），全部走 `--dsw-alias-*` token 并带中性色回退。
- [x] **Step 6: Commit** `feat: 菜单入口与重启弹窗`

### Task 8: 装进 web profile

**Files:**
- Create: `scripts/install.mjs`, `cordis.patch.yml`（包内声明）
- Modify: `~/.dsh/profiles/web/package.json`、`~/.dsh/profiles/web/cordis.patch.yml`（由脚本写，不入库）

- [ ] **Step 1:** 写 `scripts/install.mjs`：在 profile 里 `pnpm add link:<repo>`；往 profile 的 `cordis.patch.yml` 幂等追加 `- id: restart-button` / `name: dsh-restart`（已存在则跳过）；删除悬空软链 `node_modules/dsh-restart-update`。
- [ ] **Step 2:** 跑 `node scripts/install.mjs`，确认 profile 的 `package.json` 与 `cordis.patch.yml` 各多一条、软链已消失。
- [ ] **Step 3:** 手工重启一次（这时候还没有按钮），确认 `curl -s -H 'x-dsh-restart: 1' http://127.0.0.1:3080/dsh-restart/api/status` 返回端口与健康状态。
- [ ] **Step 4: Commit** `feat: 安装脚本与 profile 接线`

### Task 9: 文档补齐与验收

**Files:**
- Modify: `AGENTS.md`（启动两行）、`README.md`（跑起来）、`docs/architecture.md`（模块表 / 数据流 / 关键约束三段，从设计稿搬）、`docs/gotchas.md`（第一条坑）

- [ ] **Step 1:** 补 `AGENTS.md`「启动」为 `pnpm build && node scripts/install.mjs` 与重启方式；`check.sh` 第 ④ 段确认已是 `pnpm test`。
- [ ] **Step 2:** `docs/architecture.md` 写满三段：模块表照设计稿、数据流照设计稿第 1–5 步、关键约束挑「先回话再重启」「APFS 克隆」「请求门」三条。
- [ ] **Step 3:** `docs/gotchas.md` 第一条：现象「装完插件界面上没反应」→ 原因「客户端是构建产物且 patch 条目要重启才生效」→ 做法「`pnpm build` 后重启一次」。
- [ ] **Step 4: 跑 `bash check.sh`**，期望全绿。
- [ ] **Step 5: Commit** `docs: 补齐架构与坑`
