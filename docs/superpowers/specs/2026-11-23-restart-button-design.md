# 重启按钮（侧栏「更多」倒数第二行）设计

日期：2026-11-23 · 项目：dsh-restart · 状态：实现中（Task 3 已落兼容性快检：宿主判定 + fail-closed；Task 5 已落重启 helper：daemon 优先、自拉起兜底；Task 6 已落三条路由与请求门）

## 现在是什么情况

`dsh web` 在 3080 上由 `dsh-daemon 0.1.33` 管着（PID 77792），watchdog 未启动。装插件、改配置之后要让它生效，只能手停手起，一周三次、每次约五分钟；更麻烦的是插件装坏了这件事，往往要重启完才发现。

## 目标

侧栏左下角「更多」菜单里，倒数第二行加一颗「重启 dsh web」。点它弹一个框：先跑一次模拟启动检查，确认当前插件组合起得来，再一键重启。装坏的插件在重启之前就被拦下。

不做：dsh 自身升级、插件市场、任何更新检查。

## 每块怎么动

| 文件 | 干什么 |
|---|---|
| `src/index.ts` | 插件入口。向 `ctx.webServer.register({kind:'exact', path})` 挂三条 `kind:'exact'` 路由（`/dsh-restart/api/status`、`/dsh-restart/api/precheck`、`/dsh-restart/api/restart`）；组装下面几个模块 |
| `src/server/last.ts` | 当前端口、探 `/health`、读写 `~/.dsh/dsh-restart/last.json`、算 profile 指纹 |
| `src/server/compat.ts` | 快检 A/B：跑 `dsh --profile web --dump-config`；兼容性判定用宿主 `@deepseek-ai/dsh-app-boot` 的 `evaluatePluginCompatibility` / `getDshRuntimeVersion`，不自己写版本比较；该包**既不能静态 import（profile 的 node_modules 里没有官方包）也不能打包**，运行时按入口定位 dsh 安装根、从那里的 `node_modules` 里 `createRequire`；打包会让 `getDshRuntimeVersion()` 读回本插件自己的 version；定位或解析不到、运行时版本非法、清单里 `engines` / `peerDependencies` 形状不合规（宿主会抛错停用插件的那些）时一律判失败（fail-closed），不静默通过 |
| `src/server/smoke.ts` | 冒烟：APFS 克隆当前 profile → 临时 DSH_HOME，另起 `dsh web --port 0 --no-open`，等 `/health`，收 stderr 里的 `did not activate` 名单，杀进程、删目录（Task 4 已实现；`runSmoke` 的 `ok` 只表示 `/health` 200） |
| `src/server/restart.ts` | 重启：先回 202，再 fork 一个脱离的 helper；helper 自己先试 `dsh-daemon restart`，端口没回来就自拉起。成功判据是 `/health` 200 **且**本插件 `/dsh-restart/api/status` 200；profile 名 / DSH_HOME / dsh 路径优先用调用方显式传入的值，缺参才从 `profileDir` 反推 |
| `src/client/inject.ts` | 往「更多」弹层倒数第二行插入 menuitem + MutationObserver 补挂；锚点找不到时退到账号菜单旁 `[data-slot="settings.launcher"]` 上方插同款行 |
| `src/client/dialog.ts` `src/client/dialog.css.ts` | 弹窗本体与样式，照参考截图 |
| `scripts/install.mjs` | 一次性装进 web profile：写依赖、链过去、往 profile 的 `cordis.patch.yml` 加条目、删悬空软链 |
| `package.json` | 构建出 `lib/index.js` + `lib/client.js`（客户端必须是构建产物，宿主不编 TS），`dsh.client = { platform: 'web', immediately: true }` |

## 数据流

1. 外壳渲染账号菜单 → MutationObserver 看到弹层出现 → 在最后一项（退出登录 / 登录）之前插一颗 menuitem。
2. 点击 → 弹窗 `GET /dsh-restart/api/status`：端口、健康、上次结果（带指纹判定是否过期），一次填满。
3. 点「开始模拟检查」→ `POST /dsh-restart/api/precheck` → 快检 A → 快检 B → 冒烟 C，阶段通过 NDJSON 流（每阶段一行，结尾 `{"done":true}`）推给弹窗，结果写 `last.json`。
4. 点「重启 dsh web」→ `POST /dsh-restart/api/restart` 先回 202，在 `res.end()` 之后的 `finish` 事件里 fork 脱离 helper（响应必须真的落到 socket，不能用固定延时赌）。
5. 弹窗轮询 `/health` 与 `/dsh-restart/api/status`，两个都 200 才显示「已回来」，90 秒超时报红。

## 通过 / 不通过怎么算

- 快检 A：`dump-config` 退出码 0 且 stderr 无 `did not activate`。
- 快检 B：每个插件按宿主的规则判兼容（engines.dsh，缺省看 dsh peer 依赖，非法范围算不满足），报出插件名与期望值。
- 冒烟 C：`/health` 200 **且** 本次启动的未激活名单里没有**基线之外的新增项**。基线 = 上一次通过时记下的名单；外部资源插件（18787、tailcat、cloudflared 这些）在试跑里稳定失败，第二次起自然落进基线，不会反复报红。弹窗里始终列出完整名单，不是只说一句「未通过」。
- 三段的失败都带具体条目标签（哪个插件、哪条约束、期望 vs 实际）。

## 关键约束

- **先回话再重启。** 重启会掐掉当前请求所在进程，响应先落 socket。
- **冒烟用 APFS 克隆，不用硬链接。** `cp -c`（clonefile）写时复制，快到忽略不计，且试跑的写入不会落到正在跑的 profile 上——硬链接会共享 inode，试跑写日志、写 auth 文件、写会话都会写进线上状态。
- **端口冲突不算红。** 试跑环境与线上必然抢 18787、18887 这类固定端口，冲突进基线，不阻断。
- **不回写运行中的 profile。** 预检全程不碰 `~/.dsh/profiles/web`。
- **重启的执行者是 helper，不是本进程。** daemon 被暂停或没装时会先 SIGTERM 再等端口，本进程会在半路死掉、拿不到结果；所以 fork 一个脱离的 helper，它先试 daemon，端口没回来就自己 `--no-open` 拉起，顺带压掉 daemon 默认开新标签页的行为。自拉起的命令是 `dsh --profile <name> --port <port> --no-open`：profile 只能指定一次，位置参数 `web` 和 `--profile web` 同时出现会被 CLI 拒绝。总预算是 `waitMs`（默认 60s）+ 插件宽限（默认 5s），自拉起和接管只用剩余额度，落在弹窗 90 秒超时之内。插件宽限的取值顺序是 deps → opts → 5s，helper 从 `DSH_RESTART_PLUGIN_GRACE_MS` 解析出的值必须经 opts 生效；start 日志行带 `home=… profile=… source=explicit|derived`，用于事后判断这次用的是显式路径还是反推值。
- **两个 POST 不收无来历的请求**：先过宿主 `connection.requestRejection`（Host/Origin 与浏览器/API 凭据），再要求 `Origin` 与 `Host` 一致、且带自定义头 `X-DSH-Restart: 1`（跨站发不出来）。本机单用户也照做——将来开到 LAN 或隧道后面，这就是远程关机按钮。唯一例外是 helper 重启后的只读就绪探针：回环地址 + `GET /dsh-restart/api/status` + 带头 + 无 Origin 时，宿主的 401 被当作放行；`precheck` / `restart` 永不享受这个例外。
- **上次结果会过期。** `last.json` 带 profile 指纹（lockfile 摘要 + dsh 版本）；对不上就显「已过期，需重新检查」，按钮回到灰禁。装完插件看到的是上一次的「通过」，正是最危险的那一刻。
- **判定回来不能只看 `/health`**：插件自己的 status 也要 200；探不到就报「插件未加载」，不能显示「已重启」——用错 profile/DSH_HOME 的进程同样 200 `/health`，但侧栏里没有按钮。

## 范围

做：菜单入口、弹窗、三段预检、重启（daemon 优先 / helper 兜底）、上次结果、日志落盘、装进 web profile 并清掉悬空的 `dsh-restart-update` 软链。

不做：多端口、多 profile、远程机器、升级、插件启停、无头浏览器验客户端加载。

## 怎么验收

- `bash check.sh` 全绿（含 `pnpm test`）。
- 单测覆盖：兼容性判定包装、基线差分、指纹失效判定——纯函数，不碰进程。
- 手工三步：菜单里能看到那一行且是倒数第二 → 点开弹窗显示端口 3080 与健康状态 → 塞一个 `engines.dsh` 写错的插件，预检必须点它的名，按钮灰禁。
- 真重启一次：页面自己回到可用状态，`last.json` 记下这次结果。
