# dsh-restart

给自己用的 DSH 插件：在侧栏账号菜单里加一颗「重启」按钮，省掉每次手停手起的五分钟。

点「重启」默认就是「先检查、再重启」：把当前 profile 克隆一份、另起一个实例试跑，确认这堆插件还起得来，才真的重启。装坏的插件在重启之前就被拦下，而不是等 dsh web 起不来才发现。确实不想等这一轮（比如刚验证过、或者就是要强行拉起来），勾上「我知道风险，跳过检查直接重启」再点，就直接重启。

## 按钮做什么

- 位置：左下角头像 → 更多 → 菜单倒数第二行「重启」（夹在「意见反馈」和登录 / 退出那一行之间）。侧栏底部不另加行，免得把「更多」挤掉。
- 弹窗分五段：服务（端口、健康）、模拟检查、重启、上次结果；标题就是「重启」，只有一颗「重启」按钮，没有单独的「开始检查」。
- 不勾「跳过检查」时，点「重启」先跑三段：dump-config、插件版本快检、克隆副本冒烟；服务端用 NDJSON 逐行推阶段，弹窗逐条画出来。全过才自动接着发重启请求，不用点第二次。
- 只有两件事会拦住这一轮：配置合不出来、试启动起不来（这时不发重启请求）。插件版本不符、缺包、试跑里没激活，都只画成黄字提示（宿主本来也只是跳过那个插件，web 照样能起）。
- 勾上「我知道风险，跳过检查直接重启」再点「重启」：不跑预检，直接发重启请求。勾选框一直显示、默认不勾；检查或重启进行中，按钮和勾选框一起锁住。
- 「重启」：服务端先回 202，再派生一个脱离的 helper 去重启（先试 dsh-daemon restart，端口没回来就自己 dsh --profile <name> --port <port> --no-open 拉起）。回来后两段探针都要过：/health 200 且插件自己的 /dsh-restart/api/status 200，否则报「web 已起来但插件未加载」。都没问题就自己关掉弹窗、刷新当前页（不新开标签页，也不用你手刷）。
- 预检不往真实 profile 写任何东西：只在 APFS 克隆出来的临时 DSH_HOME 里试跑。结果写 ~/.dsh/dsh-restart/last.json，带 profile 指纹（lockfile + dsh 版本），装完插件会显示「已过期」。

## 给 agent 的两个工具

插件还会把两个工具注册进宿主的工具表（代码在 `src/tools/`），agent 不点弹窗也能预检或重启：

| 工具 | 参数 | 做什么 | 返回 |
|---|---|---|---|
| `dsh_restart_precheck` | 无 | 跑与弹窗同一套三段预检（配置合成 → 插件兼容 → 克隆 profile 试启动），共用同一把进程锁；已有预检在跑时不排队，直接返回 `busy` | `ok` / `busy` / `cancelled` / `saved` / `durationMs` / `health` / `failures[]` / `warnings[]` / `entries[]` / `fingerprint` / `summary`，11 个字段全有值 |
| `dsh_restart` | `force?: boolean` | 先走重启守卫（profile / 端口 / restart.lock），再决定要不要预检；通过后延迟约 2.5 秒派生 helper，并结束当前回合。**调用它会中断本会话**；浏览器页面在重启完成后由弹窗自己刷新（agent 调用时那一侧的页面刷新不了，需要用户自己刷） | `ok` / `restarted` / `reason` / `port` / `profileName` / `failures[]` / `warnings[]` / `summary`，8 个字段全有值 |

- 什么时候跳过预检：`force: true` 直接跳过；否则若 `last.json` 里上一次预检还新鲜（profile 指纹没变）且通过，也跳过重跑；上一次判红或指纹过期才现场跑。
- 判红怎么办：`dsh_restart` 返回 `reason: "precheck-failed"` 和失败清单，不重启。确认风险后由调用方显式传 `force: true` 再调一次；工具不会自己 force。
- 其它不重启的 `reason`：`busy`（已有重启或预检在进行）、`no-profile`、`no-port`（webServer 还没监听端口）、`precheck-busy`、`cancelled`、`error`。
- 两个工具与 HTTP 路由共用 `src/server/precheck.ts` / `src/server/issue.ts` 这一份判定核心和同一个 io，不会各算各的。

## 装它

日常就这一条路，不用 clone 本仓库：「插件 → 发现 → 添加索引源」贴上 `https://bao-gun.github.io/dsh-restart/index.json`，点装完事。想一次列全我的插件就贴聚合索引 `https://bao-gun.github.io/dsh-plugins/index.json`。

索引里固定 `type: git` + 40 位 commit，装的就是发版那个提交；`lib/*.js` 已经在仓库里，装下来直接加载、不跑构建。索引怎么生成、发一版注意什么见 `docs/market.md`（仓库已转 public，这条路是通的）。

不想开界面时，等价的做法：

```bash
cd ~/.dsh/profiles/web
pnpm add "git+https://github.com/Bao-Gun/dsh-restart.git#<索引里那个 40 位 commit>"
$EDITOR package.json    # 把 "dsh-restart" 加进 dsh.profile.bundles 数组
```

这个手动登记不能省：宿主只给 `dsh.profile.bundles` 里的包加载它自带的 `cordis.patch.yml`，光进 `dependencies` 是「装了不生效」。同理也别再往 profile 的 `cordis.patch.yml` 手写 `restart-button`，bundle 已经插过一次，重复插会多出按钮。

装完重启一次 dsh web 让 profile 重新加载；往后就点侧栏那颗按钮了。

## 本地开发

改代码时才需要（改完 `pnpm build`，`lib/*.js` 要跟着提交，否则发出去的是旧产物）：

```bash
pnpm install && pnpm build        # 产物: lib/index.js、lib/client.js、lib/helper.js
node scripts/install.mjs --verify # 在 cp -c 克隆的副本里装一遍，起 port=0 实例，探 status 200
```

`node scripts/install.mjs --apply` 是本机 `link:` 链路（往 profile 写依赖 + `cordis.patch.yml` 的 insert 块），跟索引装互斥：要用它，先把 `"dsh-restart"` 从 `dsh.profile.bundles` 摘掉、`pnpm remove dsh-restart`，否则按钮会被插两次；切回索引装就照上一节重来。

## 第一次装完怎么确认生效

左下角头像 → 更多 → **菜单倒数第二行**是「重启」（最后一行是登录 / 退出登录）。

看不到这一行时按这个顺序查：

1. 在 `~/.dsh/profiles/web` 里 `pnpm list dsh-restart` 看依赖是不是 `github:Bao-Gun/dsh-restart#<commit>`，再确认 `package.json` 的 `dsh.profile.bundles` 里有 `"dsh-restart"`——依赖在、bundles 里没有，就是「装了不生效」。
2. 看 dsh web 的 stderr 有没有 `1 entry did not activate`——插件解析不到时 dsh web 照样起得来，只是按钮不出现，失败模式是「静默消失」而不是「起不来」（见 docs/gotchas.md）。
3. `curl -H 'x-dsh-restart: 1' http://127.0.0.1:3080/dsh-restart/api/status`：404 说明插件没加载，200 说明只是菜单行没插上。

## 万一没回来（终端救回）

重启走的是「先杀旧 web，再由 helper 拉起」。helper 是脱离的单进程，杀旧 web 之后如果它自己死了，就没有东西再拉起 web——这时界面全无，只能在终端救：

```bash
dsh-daemon status                 # 先看托管状态（登录后 watchdog 会每 10s 探活）
dsh-daemon start                  # 让 watchdog 或托管进程把 web 拉回来
dsh web                           # 还不行就前台起一次，报错直接打在屏幕上
```

如果报错指向本插件（`dsh-restart` 加载失败），先把它从 profile 摘掉再起：

```bash
# 插件是 bundle：从 profile 的 package.json 的 dsh.profile.bundles 里删掉 "dsh-restart"
$EDITOR ~/.dsh/profiles/web/package.json
# 连包一起清：cd ~/.dsh/profiles/web && pnpm remove dsh-restart
# 然后照常 dsh web；插件摘掉后 dsh web 一定能起（失败模式只会是「按钮不出现」）
```

不想动配置时，也可以先确认问题不在插件：`cd ~/.dsh/profiles/web && pnpm install --offline` 修一遍依赖再起。

## 检查

```bash
bash check.sh
```

## 目录

| 路径 | 放什么 |
|---|---|
| `src/` | 代码 |
| `docs/architecture.md` | 系统怎么跑 |
| `docs/gotchas.md` | 踩过的坑 |
| `.work/` | 草稿，不进 git |

每类内容该写在哪、什么时候读哪个文件：见 `AGENTS.md`。
