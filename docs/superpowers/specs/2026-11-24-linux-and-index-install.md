# Linux 适配与索引安装（设计稿）

日期：2026-11-24。目标：让 dsh-restart 在 Linux（飞牛 NAS）上从插件市场索引装得下、跑得起来，和 macOS 表现一致。

## 现状取证（2026-11-24 实测）

飞牛 NAS（`ssh nas`，192.168.5.254，admin）：

| 事实 | 值 |
| --- | --- |
| 系统 | Debian 12 (bookworm)，x86_64，内核自带 trim 标识 |
| 根文件系统 | ext4（**不支持 reflink**） |
| node / pnpm / dsh | v24.22.1（/usr/local/bin） / 10.34.9（~/.local/bin） / 0.2.2-rc.5（/usr/local/bin/dsh） |
| dsh web | 由 dsh-daemon 0.1.35 托管，127.0.0.1:3080，profile `web`；进程 PATH 含 /usr/local/bin |
| profile 体积 | 83 MB（node_modules 80 MB）；`cp -R` 整拷贝 0.52 s |
| `cp -c -R` | `cp: invalid option -- 'c'`，非 0 退出（GNU coreutils 没有 clonefile） |
| `dsh --profile web --dump-config` | 退出 0，2006 行，stderr 无 `did not activate` |
| `ps -p PID -o lstart= -o command=` | `Tue Nov 24 10:31:59 2026 ...`，与现有英文正则匹配 |
| daemon watchdog（Linux 版） | 与 macOS 同形：`OPEN_BROWSER = 1` 硬编码、`SSH_CONNECTION`/`SSH_TTY` 是唯一闸口、浏览器用 `xdg-open` |

在 NAS 上跑现有 `check.sh`（仓库源码 rsync 到 /tmp 后 `pnpm install` 21 s）：**268 个用例全过、构建成功**（唯一红的是我 tar 传输带进去的 `._*` 幽灵文件，不是仓库问题）。

仓库/索引现状：

- GitHub 仓库已 public，Pages 索引 `https://bao-gun.github.io/dsh-restart/index.json` 返回 200。
- 索引里的 `commit` 是 `ddff340`，比 HEAD `115096f` 旧——现在从索引装，装到的是旧产物。
- `lib/*.js` 已进 git（`.gitignore` 只放掉 sourcemap）。
- NAS 的 `~/.dsh/profiles/web` 还没装本插件（`/dsh-restart/api/status` 404），可作为干净目标。

## 决定

1. **克隆策略按平台给候选**：`src/server/clone.ts` 导出 `cloneCandidates(platform)`——darwin `['-c','-R']`；linux `['--reflink=auto','-R']` 失败再 `['-R']`；其它 `['-R']`。`scripts/install.mjs` 的 `cloneArgs` 用同一张表，由一条测试把两边钉在一起。理由：ext4 上 `--reflink=auto` 自动退化成整拷贝（0.5 s，可接受），btrfs 上真 CoW；macOS 仍走 clonefile。绝不用硬链接（会共享 inode，试跑写进线上 profile）。
2. **ps 身份解析抽成纯函数** `parsePsIdentity`，同时钉住 macOS 与 Linux 两种 `lstart` 样本。现有正则两种都能匹配（已实测），抽出来是为了有用例兜住。
3. **不改 `resolveDshBin`**：仍 `DSH_RESTART_DSH_BIN` 优先、否则 `dsh`。NAS 上 dsh web 的 PATH 已含 /usr/local/bin，实测可解析；不做 argv[1] 反推（YAGNI），改为在 gotcha 里写清「PATH 里没有 dsh 就是 ENOENT」。
4. **发布顺序固定**：改版本号 → `pnpm build` → 提交（含 `lib/*.js`）→ `pnpm market:index` → 提交索引 → 推送。新增 `scripts/check-index.mjs` 在 `check.sh` 里断言「索引里的 commit 指向仓库中确有 `lib/index.js` 与 `lib/client.js` 的提交」。
5. **验收在 NAS 上从索引装**：市场 UI 走 `ssh -L` 隧道访问 NAS 的 dsh web（token 由 `dsh-daemon status` 给出），加索引源 → 装插件 → 用按钮重启一次 → 预检/工具/按钮三样都验。

## 不做

- 不支持 Windows（现状已 skip）。
- 不为 Linux 单独做一套守护逻辑：`dsh-daemon` 优先、失败自拉起，两个平台同一条路。
- 不把 `install.mjs` 软链装法推广到别的机器（AGENTS.md 已定：索引装是换机器的路）。
