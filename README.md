# dsh-restart

给自己用的 DSH 插件：在侧栏账号菜单里加一颗「重启 dsh web」按钮，省掉每次手停手起的五分钟。

这颗按钮不直接重启。点开先跑一轮模拟启动检查——把当前 profile 克隆一份、另起一个实例试跑，确认这堆插件还起得来——通过了才允许真重启。装坏的插件在重启之前就被拦下，而不是等 dsh web 起不来才发现。

## 按钮做什么

- 位置：左下角头像 → 更多 → 菜单倒数第二行「重启 dsh web」（夹在「意见反馈」和登录 / 退出那一行之间）。
- 弹窗分四段：服务（端口、健康）、模拟检查、重启、上次结果；标题下还有一行提示说明「上次通过不算数」。
- 「开始模拟检查」跑三段：dump-config、插件兼容性快检、克隆副本冒烟；服务端用 NDJSON 逐行推阶段，弹窗逐条画出来。失败会点名哪个插件、哪条约束。
- 「重启 dsh web」：服务端先回 202，再派生一个脱离的 helper 去重启（先试 dsh-daemon restart，端口没回来就自己 dsh --profile <name> --port <port> --no-open 拉起）。回来后两段探针都要过：/health 200 且插件自己的 /dsh-restart/api/status 200，否则报「web 已起来但插件未加载」。
- 预检不往真实 profile 写任何东西：只在 APFS 克隆出来的临时 DSH_HOME 里试跑。结果写 ~/.dsh/dsh-restart/last.json，带 profile 指纹（lockfile + dsh 版本），装完插件会显示「已过期」。

## 跑起来

```bash
pnpm install && pnpm build        # 产物: lib/index.js、lib/client.js、lib/helper.js
node scripts/install.mjs          # dry-run：只打印将写进 profile 的改动，不动文件
node scripts/install.mjs --verify # 可选：在 cp -c 克隆的副本里装一遍，起 port=0 实例，探 status 200
node scripts/install.mjs --apply  # 真写：profile 的 package.json 依赖、cordis.patch.yml 的 insert 块、node_modules 软链
```

装完要重启一次 dsh web 让 profile 重新加载。第一次只能手动重启（那时按钮还没加载出来）；之后就可以点按钮了。

## 第一次装完怎么确认生效

左下角头像 → 更多 → **菜单倒数第二行**是「重启 dsh web」（最后一行是登录 / 退出登录）。

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
