# dsh-restart 对外提供预检与重启工具 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 agent 能自己调用「预检」和「重启」：往宿主 `ctx.tools` 注册 `dsh_restart_precheck` 与 `dsh_restart` 两个工具，判定与预检/重启路由共用同一套代码。

**Architecture:** 先把现在写在 HTTP handler 里的预检与重启逻辑抽成 `src/server/precheck.ts`（带阶段回调与进程级互斥）和 `src/server/issue.ts`（守卫 + 派生 helper），路由改成薄适配层；再用 `defineTool` 的等价普通对象注册两个工具，预检工具直接跑核心，重启工具「新鲜通过就跳过预检、否则先跑预检、判红要 force」，返回结果后延迟 2.5s 才派生 helper，让工具结果先落盘。

**Tech Stack:** TypeScript + tsup（宿主入口 esm/node，external `@deepseek-ai/*`）+ vitest；宿主 0.2.2-rc.5 的 `@deepseek-ai/dsh-tools` 工具契约。

**Spec:** 无新 spec。需求原文（用户 2026-11-23）：「对外提供预检和重启的工具」。共享判定模型沿用 `docs/superpowers/specs/2026-11-23-restart-button-design.md`：预检只拦「配置能合成 + 试跑实例能起来且清理干净」，插件级问题一律提示。

## Global Constraints

- 运行期零第三方依赖：`src/` 里不得 import 任何 `@deepseek-ai/*`（tsup 只把它们标 external，仓库 devDependencies 里也没有），新增代码只用 node 内置模块。因此工具定义写成普通对象，不用 `defineTool`。
- 预检判定模型不变：`ok = configFailures.length === 0 && bootOk`，`bootOk = smoke.ok && smoke.health && smoke.failures.length === 0`；compat 阶段恒 `ok: true`，问题进 `warnings`。
- `check.sh` 只准改 ④ 段，且只准加严（删断言 / `|| true` / `exit 0` 都算作弊）。
- 测试不得写真实 `~/.dsh/profiles/web`、不得重启本机 dsh web（会掐掉当前会话）。
- 并发提交只 `git add` 自己改的文件；禁用 `git commit --amend`、禁用 `git add -A`。
- `.githooks/pre-commit` 的 doc-drift 规则：`docs/` 里点名过的 `src/` 文件被改动，同一次提交必须改那份 doc。
- 工具名、参数名、输出字段名一旦定下，测试、文档、后续任务都用同一套写死：`dsh_restart_precheck`、`dsh_restart`、`force`、`ok/busy/cancelled/saved/durationMs/health/failures/warnings/entries/fingerprint/summary`、`restarted/reason/port/profileName`。

## Review Focus

- 工具一调用就把宿主进程杀掉，工具结果还没落盘：会话里可能留一条没有结果的调用，重启后无法解释。Task 5 用「延迟 arm + `concludeTurn`」的用例钉住顺序，Task 6 真机确认结果确实出现在会话里。
- 预检跑到一半用户取消（Esc / 关会话）：不得留 smoke 临时目录或孤儿 dsh。Task 1 钉「取消后不写盘、结论作废」，Task 4 钉「signal 中断返回 `cancelled: true` 而不是成功」。
- 两个会话同时调预检或重启：不能起两个 helper 抢同一个端口，也不能并行克隆两次 profile。Task 1 钉进程级互斥，Task 5 钉 `busy` 分支零副作用。
- 预检判红时重启工具仍然落了手：破坏「预检不过不重启」这个承诺。Task 5 钉 `force=false` 时 `scheduleRestart` 一次都没被调用。
- 非 web 上下文（无端口 / 无 profileContext）被当成成功：工具返回成功但什么都没做。Task 5 钉守卫失败时 `restarted: false` 且不派生 helper。

---

### Task 1: 抽出预检核心 `src/server/precheck.ts`

**Files:**
- Create: `src/server/precheck.ts`
- Modify: `src/index.ts`（`precheck` handler 改成薄适配层；`RouteIo` 改成 `extends PrecheckIo`）
- Test: `test/precheck.test.ts`（新建）

**Interfaces:**
- Consumes: `src/server/smoke.ts` 的 `runDumpConfig`、`runSmoke`、`diffFailedEntries`、`SmokeResult`；`src/server/compat.ts` 的 `readInstalled`、`compatFailures`、`InstalledPlugin`；`src/server/last.ts` 的 `readLast`、`writeLast`、`computeFingerprint`；`src/shared/types.ts` 的 `Failure`、`LastRecord`、`PrecheckResult`。
- Produces（后续任务与路由都按这些名字调用）:

```ts
export interface PrecheckIo {
  now(): Date
  readLast(dir: string): Promise<LastRecord>
  writeLast(dir: string, patch: Partial<LastRecord>): Promise<void>
  computeFingerprint(profileDir: string, dshVersion: string | null): Promise<string | null>
  runtimeVersion(): string | null
  runDumpConfig(profileDir: string): Promise<Failure[]>
  readInstalled(profileDir: string, onWarning?: (failure: Failure) => void): Promise<InstalledPlugin[]>
  compatFailures(plugins: InstalledPlugin[], runtimeVersion: string): Failure[]
  runSmoke(options: { profileDir: string; tmpRoot: string }): Promise<SmokeResult>
  tmpRoot: string
  logDir: string
}

/** 预检的宿主上下文：profile 目录 + 名字 + dsh home。 */
export interface PrecheckTarget { dir: string; name: string; home: string }

export type PrecheckStage =
  | { stage: 'config'; ok: boolean; failures: Failure[] }
  | { stage: 'compat'; ok: true; failures: []; warnings: Failure[] }
  | { stage: 'boot'; ok: boolean; failures: Failure[]; warnings: Failure[]; entries: string[]; added: string[]; health: boolean }

export interface PrecheckOutcome {
  ok: boolean
  saved: boolean
  cancelled: boolean
  fingerprint: string | null
  failures: Failure[]
  warnings: Failure[]
  entries: string[]
  health: boolean
  durationMs: number
  error?: string
}

/** 进程级互斥：同一进程只允许一轮预检（路由与工具共用这一把锁）。 */
export function acquirePrecheck(): boolean
export function releasePrecheck(): void

export async function runPrecheckRun(
  io: PrecheckIo,
  target: PrecheckTarget,
  options: { onStage?: (stage: PrecheckStage) => void; isCancelled?: () => boolean } = {},
): Promise<PrecheckOutcome>
```

- [ ] **Step 1: 写失败的测试** `test/precheck.test.ts`

```ts
// 假 io 只实现 PrecheckIo；每个用例按需覆盖字段
function fakeIo(overrides: Partial<PrecheckIo>): PrecheckIo { /* ... */ }

it('通过时写 precheck + baseline + fingerprint，并返回 saved: true', async () => {
  const written: Array<Partial<LastRecord>> = []
  const stages: string[] = []
  const outcome = await runPrecheckRun(fakeIo({ writeLast: async (_d, patch) => { written.push(patch) } }), TARGET, {
    onStage: (stage) => stages.push(stage.stage),
  })
  expect(stages).toEqual(['config', 'compat', 'boot'])
  expect(outcome).toMatchObject({ ok: true, saved: true, cancelled: false })
  expect(written).toHaveLength(1)
  expect(written[0].baseline).toEqual([])
})

it('判红时只写 precheck + fingerprint，baseline 不动', async () => { /* smoke.failures 一条 → ok false，written[0].baseline === undefined */ })

it('取消后不写盘，outcome 带 cancelled 和已跑完的 smoke 字段', async () => { /* isCancelled 在 boot 之后返回 true */ })

it('fingerprint 为 null 时不写盘，saved 为 false', async () => { /* computeFingerprint → null，ok 仍为 true */ })

it('第二次 acquirePrecheck 返回 false，release 之后能再取', () => { /* acquire/acquire/release/acquire */ })

it('dump-config 抛错时给出快检执行失败，而不是整体异常', async () => { /* runDumpConfig 抛错 → failures[0].kind === 'config' */ })
```

- [ ] **Step 2: 跑测试确认全红**

Run: `pnpm vitest run test/precheck.test.ts`
Expected: FAIL，`Cannot find module '../src/server/precheck'`

- [ ] **Step 3: 实现 `src/server/precheck.ts`**

把 `src/index.ts` 里 `precheck` handler 第 251–371 行那段逻辑原样搬进来，逐处把「写 NDJSON」换成 `options.onStage?.(stage)`、把 `cancelled` 变量换成调用 `options.isCancelled?.() ?? false`；返回 `PrecheckOutcome`。互斥用模块级 `let running = false`：

```ts
let running = false
export function acquirePrecheck(): boolean { if (running) return false; running = true; return true }
export function releasePrecheck(): void { running = false }
```

- [ ] **Step 4: 让 `src/index.ts` 的 precheck handler 改调核心**

handler 只保留：请求门 → `profileOf` → `acquirePrecheck()`（失败回 409）→ 建 NDJSON 头 → `runPrecheckRun(io, target, { onStage: write, isCancelled: () => cancelled })` → 按 `outcome` 写 `boot`/`done` 行（`cancelled` 时照旧补 `cancelledPayload` 的两行）→ `finally { releasePrecheck(); res.end() }`。`RouteIo` 改成 `export interface RouteIo extends PrecheckIo { probeHealth(...); scheduleRestart(...); isRefused(...) }`。

- [ ] **Step 5: 跑全量测试**

Run: `pnpm test`
Expected: 既有 202 例 + 新增 6 例全绿（尤其 `test/routes.test.ts` 里的 NDJSON 行形状用例不许改）。

- [ ] **Step 6: 提交**

```bash
git add src/server/precheck.ts src/index.ts test/precheck.test.ts
git commit -m "refactor: 抽出预检核心，路由改成薄适配层"
```

### Task 2: 抽出重启守卫与派生 `src/server/issue.ts`

**Files:**
- Create: `src/server/issue.ts`
- Modify: `src/index.ts`（`restart` handler 改用守卫与 arm）
- Test: `test/issue.test.ts`（新建）

**Interfaces:**
- Consumes: `src/server/restart.ts` 的 `RESTART_LOCK_NAME`、`scheduleRestart`、`ScheduleRestartOptions`。
- Produces:

```ts
export interface RestartIssueIo {
  logDir: string
  isRefused(lockPath: string): Promise<boolean>
  scheduleRestart(options: ScheduleRestartOptions): void
}

export type RestartGuard =
  | { ok: true }
  | { ok: false; status: 409 | 503; error: string }

/** profile 缺失 / 端口未知 / 已有重启在进行 → ok:false。 */
export async function restartGuards(
  io: RestartIssueIo,
  target: PrecheckTarget | undefined,
  port: number | undefined,
): Promise<RestartGuard>

/** 立刻派生 helper（路由在响应 finish 后调用）。 */
export function armRestart(io: RestartIssueIo, target: PrecheckTarget, port: number): void

/** 延迟派生（工具用）：返回取消函数；定时器 unref，不挡进程退出。 */
export function issueRestartLater(
  io: RestartIssueIo,
  target: PrecheckTarget,
  port: number,
  delayMs: number,
): { cancel(): void }
```

- [ ] **Step 1: 写失败的测试** `test/issue.test.ts`

```ts
it('profile 缺失时给 503', async () => { expect(await restartGuards(io, undefined, 3080)).toMatchObject({ ok: false, status: 503 }) })
it('端口未知时给 503', async () => { /* target 有、port undefined → 503 */ })
it('lock 存在时给 409', async () => { /* isRefused → true */ })
it('armRestart 带上显式 dshHome 与 profileName', () => { /* 捕获 scheduleRestart 的 options */ })
it('issueRestartLater 只在延迟后派生一次，cancel 后不派生', () => { /* vi.useFakeTimers() */ })
```

- [ ] **Step 2: 跑测试确认全红**

Run: `pnpm vitest run test/issue.test.ts`
Expected: FAIL，找不到 `../src/server/issue`

- [ ] **Step 3: 实现 `src/server/issue.ts`**（守卫判断顺序必须与现有 handler 一致：profile → port → lock，错误文案沿用「取不到 profileContext，无法重启」等原文）

- [ ] **Step 4: `src/index.ts` 的 restart handler 改调守卫**

守卫失败 → `respondJson(res, guard.status, { ok: false, error: guard.error })` 并 `release()`；成功路径保留「202 → finish/close 后 `armRestart`」与幂等 arm。进程内 `restartStarting` 互斥移到 `issue.ts` 模块级（`tryBeginRestart()` / `endRestart()`），工具与路由共用。

- [ ] **Step 5: 跑全量测试**

Run: `pnpm test`
Expected: 全绿，`test/routes.test.ts` 的 202/409/503 用例不许改。

- [ ] **Step 6: 提交**

```bash
git add src/server/issue.ts src/index.ts test/issue.test.ts
git commit -m "refactor: 抽出重启守卫与 helper 派生"
```

### Task 3: 工具注册骨架（无参数校验逻辑）

**Files:**
- Create: `src/server/profile.ts`（`ProfileInfo`、`profileOf` 从 `index.ts` 搬出）
- Create: `src/tools/index.ts`
- Modify: `src/index.ts`（`apply` 里注册工具；`apply` 改用一个 `io` 实例同时喂 handler 与工具）
- Test: `test/tools.test.ts`（新建）

**Interfaces:**
- Produces:

```ts
// src/server/profile.ts
export interface ProfileInfo { dir: string; name: string; home: string }
export function profileOf(ctx: { get(service: string): unknown }): ProfileInfo | undefined

// src/tools/index.ts
export interface ToolExecLike {
  readonly signal?: AbortSignal
  concludeTurn?(): void
}
export interface ToolDefinitionLike {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render(args: unknown, value: unknown): Array<{ type: 'text'; text: string }>
  }
  execute(args: unknown, exec: ToolExecLike): Promise<unknown>
}
export interface ToolsRegistryLike { register(definition: ToolDefinitionLike): () => void }
export function toolsOf(ctx: { get(service: string): unknown }): ToolsRegistryLike | undefined

export interface ToolIo extends PrecheckIo {
  isRefused(lockPath: string): Promise<boolean>
  scheduleRestart(options: ScheduleRestartOptions): void
}

/** 注册两个工具；返回注册成功的个数（没有 tools 服务时返回 0 并只打一条日志）。 */
export function registerTools(
  ctx: { get(service: string): unknown; effect(cb: () => void | (() => void), label?: string): void },
  io: ToolIo,
): number
```

- [ ] **Step 1: 写失败的测试** `test/tools.test.ts`

```ts
it('注册两个工具，名字与参数 schema 固定', () => {
  const defs: ToolDefinitionLike[] = []
  registerTools(fakeCtx({ tools: { register: (def) => { defs.push(def); return () => {} } } }), fakeIo())
  expect(defs.map((d) => d.name)).toEqual(['dsh_restart_precheck', 'dsh_restart'])
  expect(defs[0].parameters).toEqual({ type: 'object', properties: {}, additionalProperties: false })
  expect(defs[1].parameters.properties).toMatchObject({ force: { type: 'boolean' } })
})

it('没有 tools 服务时不抛，返回 0 并打一条日志', () => { /* ctx.get('tools') → undefined */ })
```

- [ ] **Step 2: 跑测试确认全红**

Run: `pnpm vitest run test/tools.test.ts`
Expected: FAIL，找不到 `../src/tools/index`

- [ ] **Step 3: 实现 `src/tools/index.ts` 的骨架**

两个工具先给最小实现（`execute` 直接 `throw new Error('not implemented')` 会被后续任务替换，所以本任务只断言注册形状）。注册用 `ctx.effect(() => {
  const dispose = tools.register(def)
  return () => dispose()
}, 'dsh-restart: ' + def.name)`。`toolsOf` 必须走 `ctx.get('tools')`，不要写 `ctx.tools`（未 inject 时 cordis 会抛 `cannot get property "tools" without inject`）。

- [ ] **Step 4: `apply` 接上**

```ts
export function apply(ctx: RouteContext): void {
  const io = defaultIo()
  const handlers = createHandlers(ctx, {}, io)
  // …注册三条路由（不变）
  registerTools(ctx, io)
}
```

`createHandlers(ctx, overrides = {}, io = withOverrides(defaultIo(), overrides))`，测试里的两参数调用保持可用。

- [ ] **Step 5: 跑全量测试**

Run: `pnpm test`
Expected: 全绿。

- [ ] **Step 6: 提交**

```bash
git add src/server/profile.ts src/tools/index.ts src/index.ts test/tools.test.ts
git commit -m "feat: 注册工具骨架 dsh_restart_precheck 与 dsh_restart"
```

### Task 4: `dsh_restart_precheck` 工具实现

**Files:**
- Modify: `src/tools/index.ts`
- Test: `test/tools.test.ts`（追加）

**Interfaces:**
- Consumes: Task 1 的 `runPrecheckRun`、`acquirePrecheck`、`releasePrecheck`、`PrecheckOutcome`；Task 3 的 `registerTools`、`profileOf`。
- Produces: 工具输出（canonical value，`additionalProperties: false`）

```ts
interface PrecheckToolValue {
  ok: boolean
  busy: boolean
  cancelled: boolean
  saved: boolean
  durationMs: number
  health: boolean
  failures: Failure[]
  warnings: Failure[]
  entries: string[]
  fingerprint: string   // 取不到时为空字符串
  summary: string
}
```

- [ ] **Step 1: 写失败的测试**（追加到 `test/tools.test.ts`）

```ts
it('预检工具通过时 ok:true，并写 precheck', async () => { /* fakeIo 全绿 → value.ok true, value.summary 含「通过」，writeLast 被调用一次 */ })
it('判红时 ok:false 但不抛错，failures 原样带回', async () => { /* smoke.failures 一条 boot */ })
it('已有一轮预检时返回 busy:true', async () => { /* 先 acquirePrecheck() 不释放 */ })
it('signal 中断返回 cancelled:true 且不写盘', async () => { /* controller.abort() 在 boot 之前 */ })
it('没有 profileContext 时 ok:false，summary 说明原因', async () => { /* ctx.get('profileContext') → undefined */ })
```

- [ ] **Step 2: 跑测试确认全红**

Run: `pnpm vitest run test/tools.test.ts`
Expected: FAIL（`not implemented`）

- [ ] **Step 3: 实现**

`execute` 顺序：`profileOf(ctx)` 为空则直接返回 `{ ok: false, ... summary: '取不到 profileContext，无法预检' }`；`acquirePrecheck()` 失败返回 `busy: true`；`try { runPrecheckRun(io, target, { isCancelled: () => exec.signal?.aborted === true }) } finally { releasePrecheck() }`；把 `PrecheckOutcome` 映射成 `PrecheckToolValue`，`summary` 用一句话（通过：「检查通过：配置能合成，试跑实例起来了（N 条提示）」；判红：「检查没通过：<第一条 failure 的 message>」；取消：「这轮预检被取消，不作数」）。`render` 返回 `[{ type: 'text', text: value.summary }]`，并附上 failures/warnings 每条一行。

- [ ] **Step 4: 跑测试确认全绿**

Run: `pnpm vitest run test/tools.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/tools/index.ts test/tools.test.ts
git commit -m "feat: dsh_restart_precheck 工具跑预检核心"
```

### Task 5: `dsh_restart` 工具实现

**Files:**
- Modify: `src/tools/index.ts`
- Test: `test/tools.test.ts`（追加）

**Interfaces:**
- Consumes: Task 2 的 `restartGuards`、`armRestart`、`issueRestartLater`、`tryBeginRestart`、`endRestart`；Task 4 的预检映射；`src/server/last.ts` 的 `isStale`。
- Produces: 工具输出

```ts
interface RestartToolValue {
  ok: boolean
  restarted: boolean
  reason: string      // 'restarting' | 'busy' | 'no-profile' | 'no-port' | 'precheck-failed' | 'precheck-busy'
  port: number        // 取不到时 0
  profileName: string
  failures: Failure[]
  warnings: Failure[]
  summary: string
}
```

- [ ] **Step 1: 写失败的测试**（追加到 `test/tools.test.ts`）

```ts
it('上次预检新鲜且通过时不再跑预检，直接延迟派生 helper 并 concludeTurn', async () => { /* last.precheck.ok 且 fingerprint 相同 → runSmoke 调用次数 0；scheduleRestart 在 2.5s 后一次；concludeTurn 一次 */ })
it('指纹变了就重跑预检，绿了才重启', async () => { /* 上次 ok 但 fingerprint 不同 → runSmoke 一次 */ })
it('判红且 force=false 时 restarted:false，且没有派生 helper', async () => { /* scheduleRestart 调用 0 次，value.reason === 'precheck-failed' */ })
it('force=true 时不跑预检直接重启', async () => { /* runSmoke 0 次，scheduleRestart 1 次 */ })
it('端口未知时 restarted:false 且不派生', async () => { /* webServer.port undefined → reason 'no-port' */ })
it('已有重启在进行时返回 reason busy', async () => { /* isRefused → true */ })
```

- [ ] **Step 2: 跑测试确认全红**

Run: `pnpm vitest run test/tools.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
execute: async (raw, exec) => {
  const args = raw as { force?: unknown }
  const force = args.force === true
  const target = profileOf(ctx)
  if (!target) return value({ ok: false, restarted: false, reason: 'no-profile', ... })
  if (!tryBeginRestart()) return value({ ok: false, restarted: false, reason: 'busy', ... })
  let armed = false
  const finish = (v: RestartToolValue) => { if (!armed) endRestart(); return v }
  try {
    const guard = await restartGuards(io, target, port)
    if (!guard.ok) return finish(value({ ok: false, restarted: false, reason: guard.status === 409 ? 'busy' : 'no-port', ... }))
    if (!force && !(await freshPassed(io, target))) {
      if (!acquirePrecheck()) return finish(value({ ok: false, restarted: false, reason: 'precheck-busy', ... }))
      const outcome = await runPrecheckRun(io, target, { isCancelled: () => exec.signal?.aborted === true })
      releasePrecheck()
      if (!outcome.ok) return finish(value({ ok: false, restarted: false, reason: outcome.cancelled ? 'cancelled' : 'precheck-failed', failures: outcome.failures, ... }))
    }
    armed = true
    endRestart()                        // 互斥只在「判定阶段」占用，派生之后交给 helper 的 lock
    issueRestartLater(io, target, port, TOOL_RESTART_DELAY_MS)
    exec.concludeTurn?.()               // 本轮到此结束，让结果先落盘再被杀
    return value({ ok: true, restarted: true, reason: 'restarting', ... })
  } catch (error) {
    return finish(value({ ok: false, restarted: false, reason: 'error', ... }))
  }
}
```

`const TOOL_RESTART_DELAY_MS = 2500`；`freshPassed(io, target)` = 读 `last` + 算 fingerprint + `!isStale(record, fingerprint)` + `record.precheck?.ok === true`。`summary`：重启「已发出重启，本会话很快会被中断，重启完成后硬刷页面」；拒绝时说明原因。

- [ ] **Step 4: 跑全量测试**

Run: `pnpm test`
Expected: 全绿。

- [ ] **Step 5: 提交**

```bash
git add src/tools/index.ts test/tools.test.ts
git commit -m "feat: dsh_restart 工具先预检再延迟派生 helper"
```

### Task 6: 构建、安装、文档与真机验收

**Files:**
- Modify: `README.md`、`docs/architecture.md`、`docs/gotchas.md`、`AGENTS.md`
- Test: 无新用例（验收靠构建 + 克隆实例 + 真机）

**Steps:**

- [ ] **Step 1: 构建并确认运行期仍是零依赖**

Run: `pnpm build && grep -c '@deepseek-ai/' lib/index.js`
Expected: 构建成功；`grep` 计数为 `0`（若命中，说明有人 import 了宿主包，必须改回普通对象）。

- [ ] **Step 2: 幂等安装 + 克隆实例验证**

Run: `node scripts/install.mjs --apply && node scripts/install.mjs --verify`
Expected: apply 输出「全部已一致，无需改动」；verify 输出 PASS，克隆实例起来后 status 200、进程组已回收。

- [ ] **Step 3: 文档**

- `docs/architecture.md`：模块表加 `src/server/precheck.ts`（三段预检核心 + 进程级互斥）、`src/server/issue.ts`（重启守卫 + helper 派生）、`src/tools/index.ts`（两个 agent 工具）；数据流补一行「agent 调工具 → 同一套 precheck/issue 核心」；关键约束加两条：「工具与路由共用同一个预检/重启核心，禁止各写一份判定」「工具执行里不得 import 宿主包」。
- `docs/gotchas.md` 追加两条：1) 未 `inject 'tools'` 时 `ctx.tools` 属性访问会抛，必须 `ctx.get('tools')`；2) 重启工具必须延迟派生 helper 并 `concludeTurn()`，否则工具结果还没落盘进程就没了。
- `README.md` 与 `AGENTS.md`：一句话说明插件给 agent 两个工具，且「调用 dsh_restart 会中断当前会话」。

- [ ] **Step 4: 验收脚本**

Run: `bash check.sh`
Expected: exit 0，输出里的用例数 ≥ 226（既有 202 + 本计划新增 24）。

- [ ] **Step 5: 提交并推送**

```bash
git add README.md AGENTS.md docs/architecture.md docs/gotchas.md
git commit -m "docs: 补两个 agent 工具与共用判定核心"
git push
```

- [ ] **Step 6: 真机验收（需要用户配合一次重启）**

重启 dsh web 后在 GUI 里让 agent 依次调用 `dsh_restart_precheck`（应返回通过 + 提示条数）与 `dsh_restart`（应先返回「已发出重启」、会话随后中断、硬刷后服务回来、会话里能看到这条工具结果）。把观察结果记进 `docs/gotchas.md` 或本条计划末尾。

---

## 自检记录

- Spec 覆盖：需求「预检工具」「重启工具」→ Task 4、Task 5；两者共用判定 → Task 1、Task 2、Task 3；装进真机 → Task 6。
- 类型一致性：`PrecheckTarget` 同时被预检与重启复用；`RestartIssueIo` 只含 `logDir/isRefused/scheduleRestart`；`ToolIo extends PrecheckIo` 并补两项，与 `RouteIo` 结构兼容。
- 已明确不做：不改客户端弹窗、不改判定模型、不给工具加 `timeoutMs`（核心跑不到可中断的静默点，声明它等于撒谎）。
