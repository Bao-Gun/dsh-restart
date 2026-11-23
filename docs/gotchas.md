# 坑

只追加，不整理。一条一行：什么情况下会踩 → 为什么 → 怎么绕。
整理过的坑会失真，宁可粗糙也别汇总成「注意事项」。

- 自拉起写成 `dsh web --profile web ...` → `error: option '--profile <name>' argument 'web' is invalid. select a profile only once`，web 根本起不来 → 位置参数和 `--profile` 是同一个设置的两种写法，只能选一种；helper 自拉起用 `dsh --profile <name> --port <port> --no-open`。
- `dsh-daemon restart` 在「距上次启动 <15s」时打印 `restart skipped` 并以 0 退出，旧 web 一直活着 → 只看退出码会把「没重启」当成功 → helper 必须自己观察 `/health` 先掉后回；退出码 0 且端口没掉按跳过处理（返回 1）。
- 冒烟只克隆 `~/.dsh/profiles/web` 这一层 → home 级 `.env` / `settings.yaml` / `plugins` / `daemon` 不在临时 DSH_HOME 里，真实启动依赖这些时结果会假红或假绿 → 失败信息统一带「仅克隆 profile 层」，别把冒烟当成完整启动验证。
- 宿主被杀会留下 `dsh-smoke-*` 临时目录，里面的 `dsh.pid` 数字可能已被无关进程复用（macOS 终端常为组长），照着数字 `kill -pid` 会误杀 → 另存 `dsh.json` 的 pid + lstart + command，清扫时逐项比对，任何一项无法确认就只删目录、不发信号。
- 真实 CLI 的 profile 写法（0.2.2-rc.5 实测）：`dsh --help` 的 usage 是 `dsh [--profile] <name> [options] [app-args...]`，examples 里自拉起写法是 `dsh --profile web --no-open`；`dsh web --help` 的 usage 是 `dsh --profile web [options]`；`dsh-daemon --help` 确认存在 `restart` 子命令。→ argv 只能用一种写法，别再假设 `dsh web ...` 是唯一入口。
- `/health` 200 ≠ 插件已加载：用错 profile / `DSH_HOME` 的 dsh web 照样 200 `/health`，但 `/dsh-restart/api/status` 是 404，界面上没有按钮 → helper 必须第二段探插件状态路由（200 才算成功），探不到就报「插件未加载」，不能报「已重启」。
- 在真实 cordis ctx 上直接 `Reflect.get(ctx, 'connection')` 会抛 `cannot get property "connection" without inject`（测试里 mock 的 ctx 是普通对象，照不到这条规则，单测全绿也挡不住）→ cordis 对未声明 inject 的服务做了属性访问拦截，只能用 `ctx.get('connection')` → `connectionOf` 先 `ctx.get`，取不到再用反射兜底（src/index.ts:548-565）。
- 冒烟克隆 profile 用 `cp -al`（硬链接）→ 副本与真实 profile 共享 inode，试跑里写日志、写 auth、写会话都会落到线上 profile → 必须 `cp -c`（APFS clonefile，写时复制）；`cp -c` 失败只退回 `cp -R`（真复制），绝不退回 `cp -al`（src/server/smoke.ts:15）。
- 冒烟起的 dsh 会把 sidecar 一起拉进同一个进程组，只按 pid 杀 → sidecar 变孤儿继续占端口，下一次冒烟直接假红 → 起子进程时 `detached` 建独立进程组，收尾用 `kill(-pid)` 打整个组（SIGTERM → 轮询 → SIGKILL），并轮询确认组里没人了才算清干净（src/server/smoke.ts:238-267）。
- 往 profile 的 `cordis.patch.yml` 加顶层 `- id: restart-button` → 宿主只打印一条告警，不会新增条目，插件永远装不上 → 顶层 `- id:` 只能改已有条目，新增必须用 `- insert:` 块；`scripts/install.mjs` 的 `readPatchSnippet` 会强制校验片段以 `- insert:` 开头（install.mjs:59-66）。
- 客户端插件产物写成 esm 或忘了包一行自注册 → 宿主不加载、也不报错，按钮永远不出现，单测和构建都绿 → 客户端必须是 classic script 且自带 `window.__ModuleLoader__.load({ id, factory })`；tsup 客户端那份用 iife + banner/footer 把模块体包进 factory，保证首行自注册、副作用延迟到 materialize（tsup.config.ts:26-42）。
- 插件模块解析不到（没装、软链断、产物缺）→ dsh web 仍能启动，只是 stderr 里一句 `1 entry did not activate`，侧栏少一颗按钮 → 失败模式是「按钮静默消失」，不是「起不来」；所以装完先看这一行，预检失败的文案也要讲明白是插件没加载（见上方 /health 那条）。
- 宿主只报一条未激活时是单数 `1 entry did not activate`，正则只写 `entries` → 名单永远空，冒烟把「恰好一个插件装坏」判绿 → 单复数都要认（src/server/smoke.ts:46-47）；判绿前必须先看这一行。
- 登录后 `dsh-daemon` 的 watchdog 每 10s 探活，它和 helper 的自拉起是两套锁（watchdog 看自己的 daemon 状态，helper 用 `restart.lock`）→ helper 杀掉旧 web 后可能与 watchdog 抢同一端口，日志里出现 `EADDRINUSE` 不等于插件坏了 → 确认最后只剩一个实例、/health 200 即可。
- 菜单行注入带一条「没菜单就退到侧栏底部 `[data-slot="settings.launcher"]` 上方」的退路 → 实机上它插进 `div[data-slot="sidebar.settings"] > div.VOzbGW_triggerRow`，与「更多」并排成第二行，把「更多」挤没了 → 只在账号菜单里插；菜单没打开就什么都不插，MutationObserver 等它出现再补（src/client/inject.ts）。
- 预检把插件级问题（版本不符、清单读不动、试跑里没激活）当失败 → 实机 `dsh-mcp-connector` 的 patch 条目指向一个没装好的包，预检永远红，人根本点不了重启，而 web 其实起得好好的 → 只有「配置合不出来」和「试启动起不来」拦重启，插件问题一律 `warnings` 提示（src/index.ts 的 `ok = configFailures.length === 0 && bootOk`）。
- helper 是 detached 单进程，杀旧 web 后它自己崩了没人拉起；刚启动不到 15 秒时 daemon 还会 `restart skipped` 直接退 0 → 界面全无时只能终端救：`dsh-daemon status` → `dsh-daemon start` → 还不行 `dsh web` 前台看报错；实在不行把 profile 的 `cordis.patch.yml` 里 `restart-button` 那条 insert 块删掉再起（README「万一没回来」一节）。
- 菜单行用统一 100ms 防抖补挂 → 菜单是点了「更多」才 portal 出来的，行要等一个防抖窗口才出现，肉眼能看见「菜单先弹、行后冒」的过程 → 菜单刚出现那一次必须在 MutationObserver 回调（微任务）里当场插，只有「已经在位」之后的重渲染噪声才防抖（src/client/inject.ts 的 `onMutations`）。
- 预检判红用 `window.confirm` 做二次确认 → 宿主里是个阻塞弹框，与弹窗自己的视觉完全不搭，每次都要多点一次 → 改成弹窗内的「我知道风险」勾选框：勾上直接点亮重启按钮，勾选框只在「本轮跑完且判红」时显示（`src/client/dialog.ts` 的 `refreshGate`）。
- 在 cordis 插件里直接读 `ctx.tools` 属性（未 `inject 'tools'`）→ 抛 `cannot get property "tools" without inject`；单测里的假 ctx 是普通对象，照不出这条规则，容易全绿上线才炸 → 必须 `ctx.get('tools')` 并自己判形状，取不到就当宿主没装工具服务（`src/tools/index.ts` 的 `toolsOf`）；`profileContext` 同理走 `ctx.get`（`src/server/profile.ts`）。
- `dsh_restart` 里先 `concludeTurn()` 再 `issueRestartLater(...)` 排延迟派生 → 本轮可能立刻收尾，helper 还没排上，重启就丢了；反过来先派生再结束本轮，工具结果也来得及落盘 → 顺序必须是先 `issueRestartLater`、后 `concludeTurn`（`src/tools/restart.ts`）；2.5 秒延迟就是给落盘留的时间，helper 一启动就可能掐掉本进程。

- 主按钮文字写死 `#fff` → 暗色皮肤下 `--dsw-alias-button-primary-fill` 是接近白的 `rgb(249,250,251)`，白字白底，按钮上的「重启」看不见 → 主题把「深底白字」和「白底深字」两套都换成了 CSS 变量，文字必须用 `var(--dsw-alias-label-primary-foreground)`，别写死颜色（`src/client/dialog.css.ts`）。
- 以为 `DSH_DAEMON_OPEN_BROWSER=0` 能让 daemon 别开浏览器 → `~/.dsh/daemon/watchdog.js:227` 是 `const OPEN_BROWSER = 1;`，这个环境变量压根没接，唯一的闸口是 `watchdog.js:793` 的 `else if (process.env.SSH_CONNECTION || process.env.SSH_TTY)`，而那是个生成文件、`dsh_daemon_reinstall` 会覆盖 → 在 helper 里派生 daemon 时自己塞 `DSH_DAEMON_OPEN_BROWSER=0` 和一条假 `SSH_CONNECTION`（`src/server/restart.ts` 的 `daemonRestartEnv`），页面交给弹窗自己刷新。
- 用 `ps -o lstart=` 取进程启动时间做身份比对 → 中文 locale（`LANG=zh_CN.UTF-8`）下 macOS 打成 `一 11/23 22:40:14 2026`，与英文月份正则对不上，所有 pid 身份都变成「无法确认」，陈旧试跑的清扫因此不再发信号，孤儿实例带着端口一直活着 → 调 `ps` 时钉住 `LC_ALL=C`、`LANG=C`（`src/server/smoke.ts` 的 `probeProcessIdentity`）。


- 「上次结果」直接 `at.slice(0,16)` 切 UTC ISO 字符串 → UTC+8 机器上显示的时间永远少 8 小时（真机显示 14:26，实际 22:26） → `at` 是服务端 `toISOString()` 落的 UTC，必须 `new Date(at)` 后按本机时区的 `getFullYear/getHours` 拼字符串（`src/client/dialog.ts` 的 `formatTime`）。

