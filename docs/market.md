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
# 4. 生成索引（它指向第 3 步的提交），再提交，然后推
pnpm market:index && git add site/index.json && git commit -m "chore: 更新索引" && git push
```

推上去之后 Actions 会重跑一次生成再部署，所以第 4 步的本地提交只是为了仓库自洽，不是必需。

装的人在「插件 → 发现 → 添加索引源」里贴：

```
https://<用户名>.github.io/dsh-restart/index.json
```

## 硬约束（都是踩出来的）

- **索引的 `source` 只有 npm 和 git 两种。** `dsh-restart` 这个名字在 npm 上已被别人占用（0.1.2），走 npm 会装到别人的包，所以这里固定 `type: "git"` + 40 位小写 commit。
- **git 源装的是仓库内容，装完直接加载包入口**：不跑 `prepare`、不装 devDependencies、不构建。所以 `lib/*.js` 必须进 git（`.gitignore` 只放掉 sourcemap），否则装下来 `main: lib/index.js` 不存在。**改完代码忘了 `pnpm build` 就提交，等于把旧产物发出去。** 判断要不要重建只看改动位置：动了 `src/` 就必须重建、并把变了的 `lib/*.js` 点名叫进同一提交；只动 `scripts/install.mjs` / `site/` / 文档则不用。
- 反过来，别指望 `prepare` 脚本救场：pnpm 11 会拦 git 依赖的构建脚本（`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`），多一步审批，还得在装的人机器上装一套 tsup。
- **索引里的 commit 必须是「产物已经在仓库里」的那个提交**，所以脚本自己不提交，顺序永远是 build → commit → 生成索引。
- **仓库得是 public**：免费账号的私有仓库开不了 Pages，而且 git 源装私有仓库要凭据，「贴个 URL 就能装」就不成立了。仓库当前是 private，改成 public 之前 Pages 这一步不会成功。
- 托管有硬性要求：UTF-8 JSON、2xx、**不许重定向**、默认不超过 128 MiB。GitHub Pages 满足；换成对象存储或自建服务时注意别加一层 `301`。

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
