# 重启弹窗「一个按钮 + 常显勾选框」实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 弹窗只留一颗「重启」：不勾「跳过检查」就点，等于先跑预检、全过才真重启；勾上则跳过预检直接重启。

**Architecture:** 只改客户端。`src/client/dialog.ts` 的门禁从四个布尔（本轮通过 / 上次通过 / 跑没跑过本轮 / 是否检查中）收敛成一个 busy 标志：检查或重启进行中锁住按钮与勾选框，其余时刻按钮永远可点；点下去由 `clickRestart()` 决定「先预检再重启」还是「直接重启」。服务端三条路由与两个 agent 工具一行不动。

**Tech Stack:** TypeScript + 原生 DOM/fetch（零运行期依赖）、tsup 打包、vitest + jsdom。

**Spec:** 用户 2026-11-23 的两条要求（原话）：「1、把预检按钮删除，点击重启默认就是先预检后重启 2、把强制重启的选择项，默认放开，选中之后就直接重启，不需要预检」。旧设计稿 `docs/superpowers/specs/2026-11-23-restart-button-design.md` 里「预检按钮 / 上次通过才可点 / 判红才露勾选框」三段已被本需求取代，冲突以本计划为准。

## 行为定案

| 此刻弹窗状态 | 勾选框 | 点「重启」的结果 |
|---|---|---|
| 刚打开 / 上次判红 / 上次通过 / 指纹过期 | 不勾 | POST precheck → 三段全过才 POST restart；判红不发 restart，只列失败项 |
| 刚打开 / 上次判红 / 上次判红后勾选 | 勾上 | 直接 POST restart，不发 precheck |
| 检查中或重启轮询中 | — | 按钮与勾选框都 `disabled`，点了没反应 |

没有「上次通过就跳过检查」这条路：上次结论只在「上次结果」那一段展示，不再有任何放行权。

**文案（逐字照抄，测试按这些字面量断言）**

- 勾选框（常显、默认不勾）：`我知道风险，跳过检查直接重启`
- 勾选框外层是 `label.dsh-restart-ack`，带 `data-dsh-restart-ack-wrap`；里面 `input[type=checkbox]` 带 `data-dsh-restart-ack`、`name="dsh-restart-ack"`、`autocomplete="off"`
- 主按钮：`data-dsh-restart-restart`，文本 `重启`
- 检查说明：`点「重启」会照着重启后的流程跑一遍：解析配置 → 看插件版本 → 试启动并探活。只有配置解析不了、或试启动起不来才会拦；勾上「跳过检查」就直接重启。`
- 检查中 notice：`正在逐项检查…`
- 全过（紧接着自动发重启）notice：有提示 `检查通过（N 条提示见上），正在重启…`；无提示 `检查通过，正在重启…`
- 判红 notice：`预检没通过（N 项）：先按上面的失败项修；确实要现在重启，勾上「跳过检查」再点重启。`（`done.error` 有值时用它整句代替）
- 检查抛错 / 409：`检查失败：<原因>`
- 指纹过期（status 里 `stale === true`）：`指纹变了：上次「通过」是旧配置的结论，这次重启会重新检查。`

## Global Constraints

- 运行期零第三方依赖：`src/client/*` 只用原生 DOM 与 `fetch`，不 import 任何包。
- 不改服务端：`src/index.ts`、`src/server/*`、`src/tools/*`、`src/shared/*` 一行不动；三条路由与两个工具契约保持原样。
- `check.sh` 只准改 ④ 段且只准加严；本次不改 `check.sh`。
- 测试不得写真机 `~/.dsh/profiles/web`、不得重启本机 dsh web（会掐掉当前会话）。
- 提交只 `git add` 本次任务自己的文件；禁 `git add -A`、禁 `git commit --amend`。
- doc-drift 钩子（`.githooks/pre-commit`）会拒「改了 `docs/architecture.md` 点名的 src 文件却不同批改该文档」的提交 → 文档必须跟代码同一个提交。

## Review Focus

1. 勾上「跳过检查」但配置本来就是坏的 → 期望直接重启（用户已明示认下风险），不许偷偷补一轮预检。→ Task 1 Step 1 用例「勾上跳过检查：只发 restart，不发 precheck」。
2. 判红之后用户不勾、再点一次「重启」→ 期望重新跑一轮预检（而不是因为上次判红就锁死，也不是直接重启）。→ Task 1 Step 1 用例「判红不发重启；不勾再点会重跑预检」。
3. 预检正跑到一半用户又点「重启」→ 期望点了没反应：不并发第二轮预检、不发 restart。→ Task 1 Step 1 用例「NDJSON 每条 stage 到达就渲染，不等整包（M3）」里的 `restartButton().disabled === true` 断言。
4. 判红后勾上又取消勾选 → 期望回到「点重启会重新预检」，不是直接重启。→ Task 1 Step 1 用例「勾上再取消：下一次点击重新预检」。
5. 预检全过了但 restart 接口回 409（比如 agent 那边正在重启）→ 期望弹窗不解锁成「可空点」、提示清楚、不重复发请求。→ Task 1 Step 1 用例「restart 回 409：解锁但提示清楚，不补发」。

## File Structure

| 文件 | 动作 | 责任 |
|---|---|---|
| `src/client/dialog.ts` | 修改 | 弹窗 DOM（删预检按钮、勾选框常显）、门禁 `refreshGate`、`runPrecheck` 返回布尔、新增 `clickRestart` 编排 |
| `src/client/dialog.css.ts` | 修改 | 删掉 `.dsh-restart-ack[hidden]` 这条已经用不到的死规则 |
| `test/inject.test.ts` | 修改 | 弹窗 14 条既有用例按新行为改断言，新增 2 条（跳检、409） |
| `README.md` | 修改 | `README.md:11` 那条「开始检查」改成「点重启自动先检查」 |
| `docs/architecture.md` | 修改 | 弹窗行、数据流首行、关键约束加一条 |
| `docs/gotchas.md` | 修改 | `:24` 那条旧做法改写；追加一条「为什么删掉预检按钮」 |

---

### Task 1: 弹窗收敛成一个按钮（代码 + 测试 + 文档，一个提交）

**Files:**
- Modify: `src/client/dialog.ts`（全文 814 行；改动集中在 :1-15 注释、:90-105 `DialogView`、:116-163 状态与 `refreshGate`、:189-208 `loadStatus`、:210-221 `renderStatus`、:250-271 `resetView`、:273-341 `runPrecheck`、:343-376 `startRestart`、:385-435 `pollUntilBack` 超时分支、:453-479 `open`、:487-493 `DialogHandlers`、:546-612 `buildDialog`、:664-667 `passedByPayload`）
- Modify: `src/client/dialog.css.ts:182-199`
- Test: `test/inject.test.ts`（:367-369 helper、:402-423、:446-459、:461-496、:498-518、:520-562、:564-574、:576-610、:612-633、:637-663、:665-684、:686-724、:726-761、:763-785、:787-824）
- Modify: `README.md:11`、`docs/architecture.md`、`docs/gotchas.md`

**Interfaces:**
- Produces（Task 2 只用得到产物断言，不 import 这些）：`refreshGate(): void`、`runPrecheck(): Promise<boolean>`（只有「本轮三段全过且弹窗还活着」才返回 `true`）、`clickRestart(): Promise<void>`、`startRestart(): Promise<void>`（内部维护 `restarting`）
- Consumes：无（本任务不依赖前面任何任务）

- [ ] **Step 1: 把测试改到新行为（此时必然红）**

`test/inject.test.ts` 逐条改（删掉 `precheckButton()` 这个 helper，:367-369 整段删）：

1. `:402` 「open 后从 status 填端口、健康与上次结果」：保留原断言，末尾补三条 —— `expect(ackWrap().hidden).toBe(false)`、`expect(ackInput().checked).toBe(false)`、`expect(restartButton().disabled).toBe(false)`。
2. `:446` 改名「指纹过期：按钮照样能点，点下去会重新检查」：断言 `textOf('[data-dsh-restart-last]')` 含 `已过期`、`noticeText()` 含 `这次重启会重新检查`、`restartButton().disabled` 为 `false`。
3. `:461` 改名「点重启先跑预检：NDJSON 逐行渲染，判红不发重启请求」：`restartButton().click()` 触发；断言阶段文案（config 通过 / compat 未通过 / boot 通过）、1 条 `[data-dsh-restart-failure]` 含 `bad-plugin`、`calls.filter(c => c.url === '/dsh-restart/api/precheck')` 长度 1、`calls.some(c => c.url === '/dsh-restart/api/restart')` 为 `false`、`restartButton().disabled` 为 `false`、`noticeText()` 含 `预检没通过（1 项）`。
4. `:498` 改名「预检全过就自己发重启，不用点第二次」：`restartButton().click()` 后 `await waitFor(() => calls.some(c => c.url === '/dsh-restart/api/restart'))`，断言 precheck 在 restart 之前（用 `calls.findIndex` 比大小）、两边的 `init.headers['x-dsh-restart']` 都是 `'1'`、restart 的 `init.method` 是 `'POST'`。
5. `:520` 「插件问题只作提示」：把 `:548` 的 `precheckButton().click()` 换成 `restartButton().click()`，把 `:549` 的 `waitFor(() => restartButton().disabled === false)` 换成 `waitFor(() => document.querySelectorAll('[data-dsh-restart-warning]').length === 2)`；删掉 `:560` 的 `ackWrap().hidden` 断言，其余（两阶段「1 条提示」、2 条黄字、0 条红字、`noticeText()` 含 `2 条提示`）保留。
6. `:564` 「标题和主按钮都叫「重启」」：补 `expect(document.querySelector('[data-dsh-restart-precheck]')).toBeNull()`。
7. `:576` 改名「判红后勾上「跳过检查」再点：直接重启，不再跑预检」：第一次 `restartButton().click()` 后等 `noticeText()` 含 `预检没通过`，断言`restart` 请求 0 次、`ackInput().checked` 为 `false`；然后 `ackInput().click()`、`restartButton().click()`、`await settle()`，断言 precheck 请求**仍为 1 次**、restart 请求 1 次。
8. `:612` 改名「勾上再取消：下一次点击重新预检」：判红后勾上、取消勾选，断言 `ackInput().checked === false` 且 `restartButton().disabled === false`；再点一次 `restartButton()`，断言 precheck 请求变成 2 次。
9. `:637` 改名「上次通过 + 本次判红：不会自动重启」：删掉开头「等按钮可用」的语义说明，改为 `expect(restartButton().disabled).toBe(false)`；点一次后断言阶段 compat 未通过、restart 请求 0 次、`ackInput().checked` 为 `false`。
10. `:665`（M1）：`precheckButton()` 全部换成 `restartButton()`（:673 的 `waitFor(() => precheckButton().disabled === false)` 换成 `waitFor(() => restartButton().disabled === false)`）。
11. `:686`（M2）、`:726`（刷新）、`:763`（M3 流式）、`:787`（m1 分包）：`precheckButton().click()` 换成 `restartButton().click()`，删掉随后的「等按钮可用再点 restart」两步 —— `:712-715`、`:753-756`、`:771-772`、`:819-820` 里第二次点击（`restartButton().click()` / `waitFor(... restartButton().disabled === false)`）全部删掉；`:686` 那条改为等 `statusCalls >= 2`；`:763` 那条把 `:778` 的断言改成 `expect(restartButton().disabled).toBe(true)`（检查中锁住），结尾 `:784` 改成 `await waitFor(() => calls.some(c => c.url === '/dsh-restart/api/restart'))`。
12. 新增两条（写在 `:665` 之前）：

```ts
  it('勾上跳过检查：只发 restart，不发 precheck', async () => {
    const { calls, fetchImpl } = fakeFetch({
      '/dsh-restart/api/status': jsonResponse(statusPayload({ last: {} })),
      '/dsh-restart/api/restart': jsonResponse({ ok: true, at: '2026-11-23T04:00:01.000Z', port: 3080 }, 202),
    })
    const dialog = mountDialog(document, { fetchImpl, pollIntervalMs: 40, timeoutMs: 2000, reload: () => {} })
    dialog.open()
    await settle()

    ackInput().click()
    expect(ackInput().checked).toBe(true)
    restartButton().click()
    await waitFor(() => calls.some((call) => call.url === '/dsh-restart/api/restart'))
    expect(calls.some((call) => call.url === '/dsh-restart/api/precheck')).toBe(false)
  })

  it('restart 回 409：解锁但提示清楚，不补发', async () => {
    const { calls, fetchImpl } = fakeFetch({
      '/dsh-restart/api/status': jsonResponse(statusPayload({ last: {} })),
      '/dsh-restart/api/restart': jsonResponse({ error: '已经有一个重启在进行中' }, 409),
    })
    const dialog = mountDialog(document, { fetchImpl })
    dialog.open()
    await settle()

    ackInput().click()
    restartButton().click()
    await waitFor(() => noticeText().includes('已经有一个重启在进行中'))
    expect(restartButton().disabled).toBe(false)
    expect(ackInput().disabled).toBe(false)
    expect(calls.filter((call) => call.url === '/dsh-restart/api/restart')).toHaveLength(1)
    expect(calls.some((call) => call.url === '/dsh-restart/api/precheck')).toBe(false)
  })
```

- [ ] **Step 2: 跑测试确认是红的**

Run: `cd /Users/penghaokun/Desktop/dsh/plugin/dsh-restart && npx vitest run test/inject.test.ts`
Expected: FAIL，红点集中在「找不到 `[data-dsh-restart-precheck]`」相关（helper 已删、用例还在点它）与「点击后没发 restart」（`:498` 等）。有红点即符合预期，不必逐条对上。

- [ ] **Step 3: 改 `src/client/dialog.ts`**

1. 顶部注释（:8-14）改成新门禁：不勾「跳过检查」点重启 = 先预检、全过才发 restart；勾上 = 直接 restart；检查/重启期间按钮与勾选框都锁住；重启后轮询 status，先见 `restarting` 再见 `health === true` 才算回来。
2. `DialogView`（:90-105）：删 `precheck: HTMLButtonElement` 与 `ack: HTMLElement` 两个字段，其余不动。
3. 状态（:116-137）：删 `localPassed`、`payloadPassed`、`roundRan`；保留 `checking`（注释改成「预检正在跑」）；新增 `let restarting = false`（注释「重启已发出、正在等它回来」）。
4. `refreshGate()`（:153-163）改成：

```ts
  const refreshGate = (): void => {
    if (view === null) return
    const busy = checking || restarting
    view.restart.disabled = busy
    view.ackInput.disabled = busy
  }
```

5. `loadStatus`（:189-208）：删掉 `:197-199` 里 `payloadPassed = ...` 那行，只留 `renderStatus(target, payload)` 与 `refreshGate()`。
6. `renderStatus`（:210-221）：`stale` 提示文案换成 `指纹变了：上次「通过」是旧配置的结论，这次重启会重新检查。`。
7. `resetView`（:250-271）：删 `:262-263`（`precheck.disabled` / 文本）与 `:266-268`（三个布尔），保留 `ackInput.disabled = false`、`ackInput.checked = false`，并把 `restarting = false` 一起复位。
8. `runPrecheck()`（:273-341）签名改 `Promise<boolean>`：
   - 开头 `if (view === null) return false`；删 `roundRan = true` / `localPassed = false` / `payloadPassed = false` / `target.precheck.*` 四行，只留 `checking = true` + `refreshGate()`；
   - 统计 `failCount`（`failures.length` 累加）；
   - `:323-327` 改成：全过 → `setNotice(...'正在重启…')` 并 `return true`；否则 → `setNotice(doneError ?? '预检没通过（' + failCount + ' 项）：先按上面的失败项修；确实要现在重启，勾上「跳过检查」再点重启。', 'error', target)`；
   - `:328-331` catch 分支 `return false`；`:332-340` finally 只留 `done()` 与 `if (live(target, ticket)) { checking = false; refreshGate() }`。
9. 新增 `clickRestart`，放在 `startRestart` 之前：

```ts
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
```

10. `startRestart()`（:343-376）：开头 `restarting = true` + `refreshGate()`，删掉 `target.restart.disabled = true` / `target.ackInput.disabled = true` / 两处 `target.precheck.disabled = ...`；409 与 catch 分支把 `restarting = false` 后再 `refreshGate()`。
11. `pollUntilBack`（:385-435）：超时分支（:421-426）删 `target.precheck.disabled = false`，改成 `restarting = false` + `refreshGate()`。
12. `open()`（:453-479）里 `buildDialog` 的 handler 表删 `onPrecheck`。
13. `DialogHandlers`（:487-493）删 `onPrecheck`。
14. `buildDialog`（:546-612）：
    - `:550` checkHint 文案换成「行为定案」里那句；
    - 删 `:576-581` 预检按钮整段与 `:592` 的 `actions.appendChild(precheck)`；
    - `:588-591` 的 restart 点击保持不变（仍调 `handlers.onRestart()`，入口只有一个）；编排放在 `open()` 的 handler 表里：`onRestart: () => { void clickRestart() }`；
    - `:597-611` 勾选框：删 `ack.hidden = true`，文案换成 `我知道风险，跳过检查直接重启`；
    - `:636` 返回对象里删 `precheck` 与 `ack`。
15. `src/client/dialog.css.ts:182-199`：删掉 `.dsh-restart-ack[hidden] { display: none } ` 那条规则（现在 label 永远不 hidden；留着就是死代码）。

- [ ] **Step 4: 跑测试确认全绿**

Run: `npx vitest run test/inject.test.ts`
Expected: PASS，`Tests` 条数 ≥ 34（原 32 条 + 新增 2 条，改名不改数量）。

- [ ] **Step 5: 跑全量验收**

Run: `bash check.sh`
Expected: `exit 0`，总用例数 ≥ 267（原 265 + 2），且 ① ② ③ 段不报错。

- [ ] **Step 6: 同批改文档（doc-drift 钩子要求）**

1. `README.md:11` 那条改成：`- 点「重启」会先自己跑三段检查：dump-config、插件版本快检、克隆副本冒烟；服务端用 NDJSON 逐行推阶段，弹窗逐条画出来。勾上「我知道风险，跳过检查直接重启」就跳过检查直接重启。`
2. `README.md` 第 5 行那句「通过了才允许真重启」保留，但补一句「（判红就停下，只列失败项；确实要现在重启，勾上跳过检查再来）」。`README.md` 的「按钮做什么」一节里若还有「开始检查」，一并改成「点重启先检查」。
3. `docs/architecture.md` 弹窗行（`:21`）把后半段改成：`勾 checkbox「我知道风险，跳过检查直接重启」常显、默认不勾：不勾点「重启」= 先 POST precheck、三段全过才自动 POST restart（判红只列失败项、不发 restart）；勾上 = 跳过预检直接 POST restart；检查与轮询期间按钮和勾选框都 disabled；没有「上次通过就跳过检查」的放行路径；`close()` 里 `token++` + abort 在飞请求`。
4. `docs/architecture.md` 数据流首行：把「点「开始模拟检查」……→ 点「重启」……」改成「点「重启」（未勾跳过检查）→ `POST /dsh-restart/api/precheck`（NDJSON 逐行）→ 全过才 `POST /dsh-restart/api/restart` 回 202」。
5. `docs/architecture.md` 关键约束加一条：`- **不勾「跳过检查」就绝不跳过预检。** 弹窗只有一颗「重启」：没勾就走 precheck → restart 两段，勾了才直发 restart；「上次通过」只能展示、不能放行。`
6. `docs/gotchas.md:24` 那条改写：现在勾选框常显、默认不勾，勾上即跳过预检直接重启；仍不弹 `confirm`。
7. `docs/gotchas.md` 追加一条：`- 两个按钮（开始检查 + 重启）加一个只判红才出现的勾选框 → 用户要先点检查、再点重启，两种"上次通过"的门禁还会打架（判红后重新点亮正是最危险路径）→ 收敛成一颗「重启」+ 常显勾选框：不勾必预检，勾上必跳过（`src/client/dialog.ts` 的 `clickRestart` / `refreshGate`）。`

- [ ] **Step 7: 提交（一个提交装下代码、测试、文档）**

```bash
git add src/client/dialog.ts src/client/dialog.css.ts test/inject.test.ts README.md docs/architecture.md docs/gotchas.md
git commit -m "fix: 弹窗只留一颗重启按钮，不勾跳过检查就先预检再重启"
```

Expected: 提交成功；若 doc-drift 钩子仍然报「文档没同批改」，按提示补那份文档后重提（不许 `--no-verify`）。

---

### Task 2: 构建产物并装进 profile（不改源码、不提交）

**Files:**
- 不修改任何受版本管理的文件；产物写到 `lib/`（已在 `.gitignore` 里）

**Interfaces:**
- Consumes: Task 1 的 `src/client/dialog.ts`
- Produces: `lib/client.js`（宿主实际加载的客户端 bundle）

- [ ] **Step 1: 构建**

Run: `cd /Users/penghaokun/Desktop/dsh/plugin/dsh-restart && pnpm build`
Expected: exit 0，三份产物 `lib/index.js`、`lib/client.js`、`lib/helper.js` 都刷新。

- [ ] **Step 2: 断言产物里是新弹窗**

Run: `grep -c 'data-dsh-restart-precheck' lib/client.js; grep -c 'data-dsh-restart-ack' lib/client.js; grep -c '跳过检查直接重启' lib/client.js`
Expected: 第一个是 `0`，后两个 `> 0`。（中文字面量在产物里是 `\uXXXX` 转义，若第三条为 0，改用 `grep -c 'data-dsh-restart-ack' lib/client.js` 与 `grep -c 'clickRestart\|dsh-restart-ack' lib/client.js` 判断，别为了这条去改构建配置。）

- [ ] **Step 3: 确认安装状态一致**

Run: `node scripts/install.mjs`
Expected: 打印「全部已一致，无需改动」（软链已指向本仓库，重构建即生效，不需要 `--apply`）。若报要改，先停下把输出贴给 lead，不要擅自 `--apply`。

- [ ] **Step 4: 全量验收最后一遍**

Run: `bash check.sh`
Expected: `exit 0`，用例数 ≥ 267。

---

## 自检记录

- **Spec 覆盖**：需求 1（删预检按钮、点重启默认先预检后重启）→ Task 1 Step 3 第 8/9/10/14 条 + 用例 `:461` / `:498`；需求 2（勾选框默认放开、选中直接重启不预检）→ Task 1 Step 3 第 3/4/14 条 + 新增用例「勾上跳过检查」。
- **步骤扫描**：每个 step 都能写出一件事；没有「TBD」「处理边界」这类空话；文案与属性名全部给到字面量。
- **类型一致**：`runPrecheck(): Promise<boolean>` 在 Step 3 第 8 条定义、第 9 条 `clickRestart` 消费，两处一致；`refreshGate` 只用 `checking` / `restarting` / `view`，与删掉的四个布尔无关。
- **Review Focus**：5 条各自指向 Task 1 Step 1 里的一条用例（第 1、2、3、4、5 条）。
- **比例**：计划约 200 行，代码改动约 120 行，没有把函数体抄进计划。
