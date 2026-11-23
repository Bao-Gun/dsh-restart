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

## 跑起来

```bash
pnpm install && pnpm build        # 产物: lib/index.js、lib/client.js、lib/helper.js
node scripts/install.mjs          # dry-run：只打印将写进 profile 的改动，不动文件
node scripts/install.mjs --verify # 可选：在 cp -c 克隆的副本里装一遍，起 port=0 实例，探 status 200
node scripts/install.mjs --apply  # 真写：profile 的 package.json 依赖、cordis.patch.yml 的 insert 块、node_modules 软链
```

装完要重启一次 dsh web 让 profile 重新加载。第一次只能手动重启（那时按钮还没加载出来）；之后就可以点按钮了。

## 从索引装

仓库里带了插件市场索引源（`site/index.json`）：在「插件 → 发现 → 添加索引源」贴上 `https://<用户名>.github.io/dsh-restart/index.json`，就能像装别的插件一样一键装，不用 clone。索引怎么生成、发一版要注意什么，见 `docs/market.md`；仓库还是 private 时这条路走不通（Pages 与 git 源安装都有前提），理由也写在那份里。

## 第一次装完怎么确认生效

左下角头像 → 更多 → **菜单倒数第二行**是「重启」（最后一行是登录 / 退出登录）。

看不到这一行时按这个顺序查：

1. 跑 `node scripts/install.mjs`：结论应是「全部已一致」；若还列着待改动项，说明 --apply 没写进去。
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
# 编辑 profile 的 cordis.patch.yml，删掉 id: restart-button 那个 insert 块
$EDITOR ~/.dsh/profiles/web/cordis.patch.yml
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
