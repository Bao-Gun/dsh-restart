# Linux 适配与索引安装 实施计划

> **给执行者**：本计划用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐任务执行。步骤用 `- [ ]` 复选框。
> **设计稿**：docs/superpowers/specs/2026-11-24-linux-and-index-install.md（取证表、5 条决定、不做清单都在那里）
> **目标**：dsh-restart 在 Linux（飞牛 NAS）上①从插件市场索引装得下、②跑得起来、③「重启」按钮与两个工具和 macOS 表现一致。

## 背景

现状只剩两条坎：**克隆 profile 只在 macOS 写过路径**（`cp -c -R`，Linux 上是 `invalid option`）；**索引里的 commit 比 HEAD 旧**（ddff340 vs 115096f），从索引装会装到旧产物。其余（dump-config 预检、ps 身份、daemon 托管、watchdog）在 NAS 上实测都已匹配。

## Global Constraints

- 运行期产物零 `@deepseek-ai/*` 依赖（check.sh ④ 已有断言，不准绕过）。
- `check.sh` 只准加严：不加 `|| true`、不改 `exit 0`、不删断言。
- 测试不重启本机 dsh web、不写真实 `~/.dsh/profiles/web`（试跑只碰 `mkdtemp` 的临时 DSH_HOME）。
- 不用 `git add -A`、不用 `--amend`；每个任务单独提交（`type: 一句话`）。
- 改 `src/` 同批改 `docs/architecture.md` 对应模块行（.githooks/pre-commit 会挡）。
- 版本号一旦变，索引里必须出现新版本条目（索引一条 version 对应一个 source commit）；发布顺序固定：改版本 → `pnpm build` → 提交（含 lib/*.js）→ `pnpm market:index` → 提交 site/ → 推送。
- NAS 上任何写 profile 的动作前，先备份 `~/.dsh/profiles/web/package.json` 与 `cordis.patch.yml` 到 /tmp。
- 只走「索引装」这条路验收 NAS，不要用 install.mjs 软链装冒充（AGENTS.md 已分工）。

## Review Focus

1. **索引指向没有产物的提交** → 装下来还是旧按钮。check-index.mjs 必须用 `git cat-file -e <commit>:lib/client.js` 真的验产物，而不是比字符串。
2. **Linux 无 reflink，整拷贝 83 MB**：ext4 上 `--reflink=auto` 退化成整拷 0.52 s；若将来 profile 涨到几百 MB，可能撞 `CLONE_TIMEOUT_MS`，失败信息必须点名是克隆超时而不是「插件起不来」。
3. **PATH 里没有 dsh**（systemd/容器）：`spawn('dsh')` 直接 ENOENT，预检要报「找不到 dsh 可执行文件」，不能让用户看到白屏。
4. **没有 dsh-daemon 的 Linux**（纯 docker）：必须落回自拉起那条路，不能因为 `dsh-daemon` 不存在就报失败。
5. **市场装完 bundles 没写**：插件装了但不激活，按钮不出现——验收要看到按钮真在账号菜单里，而不是只看 `dsh plugin list`。

## 任务

### Task 1: 克隆策略按平台给候选（smoke + install 同表）

**文件**：创建 `src/server/clone.ts`；改 `src/server/smoke.ts`（`cloneProfile`，约 540 行）、`scripts/install.mjs`（`cloneArgs`，约 422 行；使用处约 575 行）；创建 `test/clone.test.ts`；改 `docs/architecture.md` 模块表。

- [ ] **写失败测试** `test/clone.test.ts`：`cloneCandidates('darwin','a','b')` = `[['-c','-R','a','b'],['-R','a','b']]`；`'linux'` 首项是 `['--reflink=auto','-R','a','b']`、次项 `['-R','a','b']`；`'freebsd'` 只有 `[['-R','a','b']]`；同一测试里 import `../scripts/install.mjs` 的导出，断言两边对 darwin/linux 给出的候选完全一致（钉住「同表」）。跑 `pnpm vitest run test/clone.test.ts` 见红。
- [ ] 建 `src/server/clone.ts`，导出 `cloneCandidates(platform, source, dest): string[][]`，纯函数、无 IO。
- [ ] `smoke.ts`：`cloneProfile` 改成遍历候选（每次失败先 `rm(dest,{recursive:true,force:true})`），首次成功即返回 null；全失败时错误信息逐条列出 `<用到的参数>：<describeCommand 结果>`，超时单独标注「克隆超时（N ms）」。
- [ ] `scripts/install.mjs`：`cloneArgs` 换成同一张表的导出（保留 `cloneArgs(source,dest,platform)` 旧签名做薄包装，别处不炸），使用处改成遍历；`--verify` 的日志打印实际用的参数。
- [ ] 跑 `bash check.sh` 绿；提交。

### Task 2: ps 身份解析抽纯函数 + 双平台样本

**文件**：改 `src/server/smoke.ts`（`probeProcessIdentity` 上方）、`test/smoke.test.ts`（或新建 `test/ps.test.ts`）。

- [ ] **写失败测试**：`parsePsIdentity('Mon Nov 24 10:31:59 2026 /usr/local/bin/node /usr/local/bin/dsh --profile web --port 0 --no-open')` 返回 `{lstart:'Mon Nov 24 10:31:59 2026', command:'...'}`；`'Tue Nov 24 10:31:59 2026 ...'`（NAS 实采样本）同样解析；`'  一 11/23 22:40:14 2026 ...'`（zh_CN 形）返回 null；空串返回 null。
- [ ] 把正则与拆分逻辑抽成 `export function parsePsIdentity(line: string): ProcessIdentity | null`（保留 `LC_ALL=C` 那段注释），`probeProcessIdentity` 只负责取 stdout 再调它。
- [ ] `bash check.sh` 绿；提交。

### Task 3: 索引自检脚本（发布环节的守门人）

**文件**：创建 `scripts/check-index.mjs`；改 `check.sh`（新增 ⑥ 段）；创建 `test/index-check.test.ts`。

- [ ] **写失败测试**：导出 `verifyIndex(index, opts)`（纯函数，`opts.commitHasArtifacts(commit, path) => boolean`）。用例：版本与 package.json 不一致 → 报错码 `version-mismatch`；commit 里没有 `lib/client.js` → `missing-artifacts` 且消息里带 commit 与新版本号；commit 是 `0000...` → 同 missing-artifacts；正常 → `{ok:true}`。另外断言 `index.json` 里不允许出现 `..` 或绝对路径的 icon。
- [ ] 实现 `scripts/check-index.mjs`：读 `site/index.json` 与 `package.json`，对每个 version 调 `verifyIndex`，`commitHasArtifacts` 用 `execFileSync('git',['cat-file','-e',`${commit}:${path}`])`；失败 `process.exitCode = 1` 并打印「先 pnpm build 再提交 lib/，再 pnpm market:index」这句指引。
- [ ] `check.sh` ④ 之后加 ⑥：`node scripts/check-index.mjs || bad "索引自检失败（见上一段输出）"`。
- [ ] `bash check.sh` 绿（此时索引还旧，应当**红**——先把 check-index 跑通再发版：若红了，说明守门人真的会挡，记录输出后进任务 4）。
- [ ] 提交（此时 check.sh 在旧索引下会红，允许一次「红着提交」，提交信息写明原因；任务 4 立刻修复）。

### Task 4: 发版 0.2.0（产物 + 索引 + 推送）

- [ ] `package.json` version → `0.2.0`；`pnpm build`；`bash check.sh` 绿（索引仍是旧版本，check-index 会红 → 说明顺序正确，继续）。
- [ ] 提交 1：代码 + 版本号 + `lib/*.js`（`git add -A lib package.json` 逐个点名，禁 `-A` 全量）。
- [ ] `pnpm market:index` → 确认 `site/index.json` 的 `versions[0].version=0.2.0`、`commit` = 刚才那次提交 → 提交 2（`site/index.json`）。
- [ ] `bash check.sh` 必须绿（此步同时验证任务 3 的守门人放行）。
- [ ] `git push`；等 Pages 生效后校验：`curl -s https://bao-gun.github.io/dsh-restart/index.json | node -e "..."` 打印 version+commit，且 `curl -sI https://raw.githubusercontent.com/Bao-Gun/dsh-restart/<commit>/lib/client.js` 返回 200。
- [ ] 把这两条命令与结果贴进任务报告。

### Task 5: NAS 上从索引安装并真机验收

- [ ] 备份：`ssh nas 'cp ~/.dsh/profiles/web/package.json /tmp/web-pkg.bak; cp ~/.dsh/profiles/web/cordis.patch.yml /tmp/web-patch.bak'`。
- [ ] 取 token：`ssh nas 'dsh-daemon status'` 拿到带 token 的 URL；本机起隧道 `ssh -N -L 18080:127.0.0.1:3080 nas`（后台任务）。
- [ ] 浏览器（本机 Chrome）打开 `http://127.0.0.1:18080/?token=<token>` → 插件 → 发现 → 添加索引源 `https://bao-gun.github.io/dsh-restart/index.json` → 装 dsh-restart 0.2.0 → 按提示重启（这颗按钮这时就已经可用；首次安装后用按钮重启，正好互相验证）。
- [ ] 验三样：①账号菜单「更多」里有「重新启动 dsh web」；②`curl -s http://127.0.0.1:18080/dsh-restart/api/status` 返回 200 且 `dshVersion` 正常；③点按钮跑预检，结果 `failures: []`（这一步在 NAS 的 ext4 上真实走过 clone 候选循环）。
- [ ] 点「重新启动」→ 等页面自己回来 → 再查 status 200、`tools/list` 里有 `dsh_restart` 与 `dsh_restart_precheck`。
- [ ] 记录：实际用了哪条 cp 候选、克隆耗时、重启耗时；红了的项原样贴出来（不许写「应该没问题」）。
- [ ] 关隧道（`job_kill`）。

### Task 6: 文档同步

- [ ] `README.md`：加「支持的平台」表（macOS 14+ / Linux x86_64+，Windows 未支持）+「从索引装」三步（加索引源、装、用按钮重启），说明索引装与软链装的分工。
- [ ] `docs/market.md`：发布顺序里插入 `node scripts/check-index.mjs`，写清它为什么存在（索引 commit 没产物 = 装了还是旧的）。
- [ ] `docs/architecture.md`：模块表加 `src/server/clone.ts`（职责：按平台给 cp 候选）；关键约束加两条（禁硬链接、索引 commit 必须含产物）。
- [ ] `docs/gotchas.md` 追加三条：GNU `cp -c` 报 invalid option；PATH 无 dsh → ENOENT；用 mac `tar` 传源码会带进 `._*` 幽灵测试文件（NAS 上 vitest 会红）。
- [ ] `bash check.sh` 绿；提交；推送。

## 收尾

全部任务后：`bash check.sh` exit 0、`git log --oneline -6` 干净、NAS 上按钮可用；把「实际怎么验的 + 哪个环节红过」写进回复，别只报绿灯。
