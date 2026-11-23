# 架构

这个系统怎么跑起来的。表里出现的路径必须真实存在（check.sh 会验）。

## 模块

| 模块 | 路径 | 职责 | 谁调用它 |
|---|---|---|---|
| 插件入口 | `src/index.ts` | 导出 `name` / `inject`，在 `apply(ctx)` 里向 `ctx.webServer.register` 挂三条 exact 路由（status / precheck / restart）；请求门（方法 + `x-dsh-restart: 1` + Origin 与 Host 一致）；precheck 用 NDJSON 逐行推三段；restart 回 202 后在 `finish` / `close` 事件里派生 helper；`precheckRunning` / `restartStarting` 进程内互斥 | 宿主插件加载器调 `apply`；浏览器弹窗发 HTTP 进来 |
| 上次结果 | `src/server/last.ts` | 读写 `~/.dsh/dsh-restart/last.json`（tmp 写 + rename，串行链）；profile 指纹 `sha256(pnpm-lock.yaml + \0 + dsh 版本)` 取前 16 位；`isStale` 判过期（取不到指纹也算过期） | `src/index.ts` 的 status 与 precheck 收尾 |
| 兼容性快检 | `src/server/compat.ts` | 读 profile 的 `package.json` 依赖与 `cordis.patch.yml`（逐行扫，不引 YAML 库）；用宿主的 `evaluatePluginCompatibility` / `getDshRuntimeVersion` 判 engines 与 peer；宿主包按入口定位 dsh 安装根再 `createRequire` 加载，不静态 import；判不了就算失败（fail-closed） | `src/index.ts` 的 precheck（compat 阶段） |
| 冒烟 | `src/server/smoke.ts` | `runDumpConfig` 跑 `dsh --profile <name> --dump-config`；`runSmoke` 把 profile `cp -c -R` 克隆进临时 DSH_HOME，起 `--port 0 --no-open` 实例，探 /health 200，从 stderr 收 `did not activate` 名单，`diffFailedEntries` 与基线差分；`killProcessTree` 杀整个进程组；finally 删临时目录 | `src/index.ts` 的 precheck（config / boot 阶段） |
| 重启调度 | `src/server/restart.ts` | `scheduleRestart` 用 `detached + stdio:ignore` 起 `lib/helper.js`；`runRestartHelper` 拿 `restart.lock`（O_EXCL，残留锁按 pid 存活 / 10 分钟年龄判）→ 先试 `dsh-daemon restart`，端口没回来就 SIGTERM 旧 web 再自己拉起；两段探针（/health 200 → 插件 status 200，宽限 5s） | `src/index.ts`（202 之后）；`src/helper/restart.ts` |
| helper 入口 | `src/helper/restart.ts` | 从 `DSH_RESTART_*` 环境变量解析配置（错误写 stderr 与 `helper-last-error.log`）；只在被直接执行时跑 `helperMain` | `scheduleRestart` 拉起的 node 进程 |
| 客户端入口 | `src/client/index.ts` | 由宿主 `window.__ModuleLoader__.load({id, factory})` 装载，factory 返回带 `apply` 的对象；`apply` 挂菜单行注入器、点开时懒挂弹窗，`ctx.effect` 里清理 | 宿主 ClientModuleSystem |
| 菜单行注入 | `src/client/inject.ts` | MutationObserver（防抖 100ms）找 `[role=menu]` 且标签含「设置 / 退出」的账号菜单，把自建行插到最后一行 menuitem 之前（= 倒数第二行）；找不到菜单时退到 `[data-slot="settings.launcher"]` 上方；文案「重启 dsh web」 | `src/client/index.ts` 的 `apply` |
| 弹窗 | `src/client/dialog.ts`（样式 `src/client/dialog.css.ts`） | 五段 UI（端口 / 健康 / 模拟检查 / 重启 / 上次结果）；三个请求都带 `x-dsh-restart: 1`；precheck 按 NDJSON 逐行画阶段；重启后轮询 status，必须先见 `restarting` 再见 `health===true` 才算回来（90s 超时）；`force` 走 confirm 二次确认；`close()` 里 `token++` + abort 在飞请求 | `src/client/index.ts`（点菜单行时 mount 并 open） |
| 共享类型 | `src/shared/types.ts`、`src/shared/version.ts` | 服务端与客户端共用的记录形状（`LastRecord` / `PrecheckResult` / `Failure`）；`parseRuntime` 解析宿主版本，非法就抛 | 两端都 import |
| 安装 | `scripts/install.mjs` | 默认 dry-run 打印计划；`--apply` 写 profile 的 `package.json`（依赖 `link:<repo>`）、追加 `cordis.patch.yml` 的 insert 块、建 `node_modules` 软链、清悬空旧软链；`--verify` 在 `cp -c` 克隆的临时 DSH_HOME 里重做安装并起 `--port 0` 实例，探 /health 200 且 status 200 + `body.ok` 才算 PASS | 人工执行 |

构建：tsup 三份产物 —— `lib/index.js`（esm/node）、`lib/client.js`（iife/browser，banner 里自注册 `__ModuleLoader__`）、`lib/helper.js`（esm，带 shebang）。`@deepseek-ai/*` 一律 external。

## 数据流

点菜单行 → 弹窗 `GET /dsh-restart/api/status`（端口、/health、上次结果 + 指纹是否过期）→ 点「开始模拟检查」`POST /dsh-restart/api/precheck`（NDJSON 逐行：config → compat → boot → done）→ 克隆 profile 起 `--port 0` 副本冒烟 → 写 `~/.dsh/dsh-restart/last.json` → 点「重启」`POST /dsh-restart/api/restart` 回 202 → `res` 的 finish/close 里派生脱离的 helper → helper 重启并跑两段探针（/health 200、插件 status 200）→ 弹窗轮询 status 看到 `restarting` 消失且 `health: true`，显示「已回来」。

## 关键约束

- **运行期零第三方依赖。** 插件入口与 helper 只用 `node:` 内置模块和宿主已装的包；`@deepseek-ai/*` 全部 external，运行时从 dsh 安装根的 `node_modules` 里 `createRequire` 解析。打包它们会让 `getDshRuntimeVersion()` 读回插件自己的版本。
- **插件坏了只能降级成「按钮不出现」，绝不能拖垮 dsh web 启动。** 模块解析不到、路由注册失败、快检抛错，宿主都只是把这一条插件标记为未激活（stderr 一句 `1 entry did not activate`），dsh web 照常起。所以客户端与服务端都不能在加载期做重活、不能抛。
- **预检绝不动真实 profile。** 对 `~/.dsh/profiles/web` 只读；所有写入都发生在 `cp -c`（APFS clonefile）克隆出来的临时 DSH_HOME 里，跑完连目录一起删。运行期唯一写盘是 `last.json`，且是 tmp + rename 的原子写。
- **先回话再重启。** 重启会掐掉当前请求所在的进程，202 必须真的落到 socket，然后在 `finish` / `close` 事件里才派生 helper；不能靠固定延时赌。关弹窗 abort 只会中止预检，已受理的重启照常执行。
- **判定回来不能只看 /health。** 用错 profile / `DSH_HOME` 的实例同样 200 /health，但侧栏没有按钮；必须再探插件自己的 status 路由 200，探不到就报「插件未加载」，不能报「已重启」。
- **两个 POST 不收无来历的请求。** 先过宿主 `connection.requestRejection`，再要求 `Origin` 与 `Host` 一致且带 `x-dsh-restart: 1`；唯一例外是 helper 重启后回环地址的只读 `GET status` 探针，precheck / restart 永不享受这个例外。

## 维护

- 改了上面提到的任一模块，同批改这张表。
- 表里出现的路径必须真实存在，`check.sh` 会验。
- 与代码冲突时以代码为准，改这份文档，不要改代码迁就它。
