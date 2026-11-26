# 做成索引源

插件市场的「发现」页可以加自定义索引源：一个静态 JSON。装的人贴一次 URL，就能看到这里列出的插件、点一下装上——不用 clone、不用跑 `scripts/install.mjs`。

## 落点

| 路径 | 干什么 |
| --- | --- |
| `package.json` 的 `dsh.bundle.patch` | 声明这是个 bundle。少了这一项，市场装到一半会报 `not-a-bundle`：安装器认 bundle 的唯一依据就是 `manifest.dsh?.bundle?.patch !== undefined` |
| `scripts/build-index.mjs` | 生成索引。数据只来自 `package.json` + 脚本里的 `SHOWCASE` 常量 + git HEAD，别手改 `site/index.json` |
| `site/index.json` | 索引本身（format 1）。本地留一份方便看；CI 每次部署前重生成，线上那份永远跟着当次提交 |
| `site/icons/dsh-restart.svg` | 图标。索引里写相对路径，市场按索引 URL 解析；跨域的绝对地址必须是 https |
| `.github/workflows/pages.yml` | 把 `site/` 发到 GitHub Pages |

## 发一版

```bash
# 1. 改版本号（索引里一个版本一条 source，版本号必须变，否则会重复）
# 2. 构建 + 跑测试
pnpm build && bash check.sh
# 3. 提交代码和产物，记下发出去的这个提交
git add -A && git commit -m "feat: ..."
# 4. 生成索引（它指向第 3 步的提交），自检一遍，再提交，然后推
pnpm market:index && node scripts/check-index.mjs
git add site/index.json && git commit -m "chore: 更新索引" && git push
```

`scripts/check-index.mjs` 是 `check.sh` ⑥ 用的同一个检查，单独跑它是因为它才是「发出去的东西能不能装」的判据：**索引里那个 commit 必须真的带 `lib/index.js`、`lib/client.js`、`lib/helper.js`，而且必须和 HEAD 里的逐字节一致**。少了这一步的典型翻车是「版本号改了、产物没进提交」——索引指向的提交里没有产物（装下来起不来），或者指向旧提交（装下来还是老版本），本地 `pnpm build` 一切正常，线上才炸。这份逐字节比对也管 `src/client/` 的改动：只动了客户端注入，`lib/client.js` 没重建进提交，一样判红。一次改动同时落在客户端与服务端时（例如 0.2.2 的 issue #2 + #4），提交前对着 `git status` 确认 `lib/client.js` 和 `lib/helper.js` 都在里面——漏掉一个，装下来就是「一个 bug 修了、另一个还在」，而索引自检照样绿（它只认产物与 HEAD 一致，不认功能对不对）。

推上去之后 Actions 会重跑一次生成再部署，所以第 4 步的本地提交只是为了仓库自洽，不是必需。

## 让聚合索引跟上（插件发版后必做）

本仓的 `site/index.json` 只是**这个仓库的**索引，没有人直接添加它：装的人那边只留一条索引源——聚合索引仓 `Bao-Gun/dsh-plugins`。它也在这条链路上，但它**不会因为插件仓库发版而自己重扫**（跨仓库没有事件），触发只有三种：它自己 `site/**`、`scripts/**` 有提交，每天 03:17 的 cron，或者手动 dispatch。所以发版的最后一步是：

```bash
cd ../dsh-plugins
node scripts/build-index.mjs      # 本地看一眼解析出的版本与 commit
git add site/index.json && git commit -m "chore: 重扫索引" && git push
# 或只触发 CI，不改本仓文件：gh workflow run pages -R Bao-Gun/dsh-plugins
```

部署偶发 `Found 0 artifact(s)`（upload 与 deploy 的竞态）时重跑就行，别改 workflow：

```bash
gh run list -R Bao-Gun/dsh-plugins --limit 3
gh run rerun <run-id> --failed -R Bao-Gun/dsh-plugins
```

然后 curl 线上那份确认跟上了（别只看仓库里的文件）：

```bash
curl -s https://bao-gun.github.io/dsh-plugins/index.json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{for(const p of JSON.parse(s).plugins)for(const v of p.versions)console.log(p.name,v.version,v.source.commit.slice(0,7))})"
```

装的人在「插件 → 发现 → 添加索引源」里贴（旧地址先删掉，两份都留着会读到重复插件）：

```
https://bao-gun.github.io/dsh-plugins/index.json                                                  # 海外 / 能连 Pages
https://ghproxy.net/https://raw.githubusercontent.com/Bao-Gun/dsh-plugins/main/site/index.json    # 国内（随发版即时更新）
```

## 硬约束（都是踩出来的）

- **索引的 `source` 只有 npm 和 git 两种。** `dsh-restart` 这个名字在 npm 上已被别人占用（0.1.2），走 npm 会装到别人的包，所以这里固定 `type: "git"` + 40 位小写 commit。
- **git 源装的是仓库内容，装完直接加载包入口**：不跑 `prepare`、不装 devDependencies、不构建。所以 `lib/*.js` 必须进 git（`.gitignore` 只放掉 sourcemap），否则装下来 `main: lib/index.js` 不存在。**改完代码忘了 `pnpm build` 就提交，等于把旧产物发出去。** 判断要不要重建只看改动位置：动了 `src/` 就必须重建、并把变了的 `lib/*.js` 点名叫进同一提交；只动 `scripts/install.mjs` / `site/` / 文档则不用。查漂移最省事：跑 `bash check.sh`（内部会 `rm -rf lib && pnpm build`）后看 `git status`，没提交的 `lib/*.js` 会直接露出来。`.githooks/pre-commit` 会按同一条规则拦提交：动了 `src/`、`lib/` 的文件，`docs/`、`specs/` 里点名它的文档必须同批出现，缺一份就报 `[doc-drift]`。
- 反过来，别指望 `prepare` 脚本救场：pnpm 11 会拦 git 依赖的构建脚本（`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`），多一步审批，还得在装的人机器上装一套 tsup。
- **索引里的 commit 必须是「产物已经在仓库里」的那个提交**，所以脚本自己不提交，顺序永远是 build → commit → 生成索引。
- **仓库得是 public**：免费账号的私有仓库开不了 Pages，而且 git 源装私有仓库要凭据，「贴个 URL 就能装」就不成立了。仓库已转 public，Pages 也在正常部署。
- **国内机器走 ghproxy，别拿 jsDelivr 装最新版。** `<用户名>.github.io` 与 `raw.githubusercontent.com` 在 NAS 上实测都不可达（curl 空响应），而 `github.com`、`ghproxy.net` 通：`https://ghproxy.net/https://raw.githubusercontent.com/Bao-Gun/dsh-plugins/main/site/index.json` 随发版立刻更新（200、0 重定向；它回 `content-type: text/plain` 也能装，宿主只校验状态码、大小和 JSON 体）。jsDelivr（`cdn.`/`fastly.`/`gcore.` 三个域名同源缓存）能解析 `@main`，但响应头是 `max-age=604800, s-maxage=43200`，实测发版后调 `https://purge.jsdelivr.net/gh/<owner>/<repo>@main/<path>` 报 finished 仍继续吐旧版本；要钉死就写 40 位 commit，代价是不再跟新版。
- 托管有硬性要求：UTF-8 JSON、2xx、**不许重定向**、默认不超过 128 MiB。GitHub Pages 满足；换成对象存储或自建服务时注意别加一层 `301`。

## 真机验收记录（2026-11-24，飞牛 NAS / Debian 12 / ext4 / dsh 0.2.2-rc.5）

从「发现」页真点了一遍，不是脚本模拟：

| 环节 | 实测 |
| --- | --- |
| 添加索引源（当时还是本仓单独一条 jsDelivr 地址）→ 列表出现「重启与预检 0.2.0」 | 正常，确认框显示 commit `80a79a3` |
| 索引源换成聚合索引（ghproxy 镜像） | `dsh --profile web --dump-config` 里只剩这一条；NAS 上 curl 该 URL 200、0 重定向；官方 `parseMarketIndex` 解析出 `dsh-restart@0.2.0#5ea4149`、`dsh-upgrade@0.1.0`。界面未再点一遍（安装路径本身上面已实测） |
| 安装（git 源，clone + 装 node_modules） | ≤20s；装完 profile `package.json` 得到 `github:Bao-Gun/dsh-restart#80a79a3…`，`node_modules/dsh-restart` 就位 |
| 预检 | 11.4s，failures 0 / warnings 29（全是 NAS 上 patch 里那些模型条目缺 `package.json` 的提示） |
| 重启 | helper 7.5s 回到 healthy：`port before up` → `port down (+316ms)` → 新实例拉起 → `port up (+6857ms)` |
| 克隆耗时（84M profile） | `cp --reflink=auto -R` 0.18s、`cp -R` 0.17s（ext4 无 reflink，两者等价）、`cp -c` 报 invalid option |
| 「上次结果」 | 重启后重开弹窗显示「2026-11-24 11:46 预检通过 · 29 条提示」 |

## 本地先验一遍

```bash
pnpm market:index
node --input-type=module -e "
import { readFileSync } from 'node:fs'
const { parseMarketIndex } = await import('/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-plugin-market-index/lib/index.js')
console.log(parseMarketIndex(JSON.parse(readFileSync('site/index.json','utf8')), 'https://example.github.io/dsh-restart/index.json').plugins[0].name)
"
```

校验器是宿主自带的 `@deepseek-ai/dsh-plugin-market-index`，路径随 dsh 安装位置变，上面的绝对路径只是本机现成的那个。
