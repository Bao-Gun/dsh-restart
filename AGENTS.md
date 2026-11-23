# dsh-restart

给自己用的 DSH 插件：在 dsh web 侧栏账号菜单倒数第二行加一颗「重启」，省掉每次手停手起的五分钟。点开先跑一轮模拟启动检查（克隆 profile、起副本试跑），通过了才允许真重启——装坏的插件在重启之前就被拦下。

## 目录地图

| 路径 | 放什么 | 不放什么 |
|---|---|---|
| `src/` | 代码 | 文档、样本数据 |
| `docs/` | 说明文字 | 代码 |
| `docs/architecture.md` | 系统怎么跑：模块表、数据流、关键约束 | 需求、待办 |
| `docs/gotchas.md` | 踩过的坑，只追加不整理 | 通用编程常识 |
| `.work/` | 草稿、临时计划（不进 git） | 任何还要留下的东西 |
| `check.sh` | 唯一的验收脚本 | —— |

## 什么时候读什么

| 你要做 | 先读 |
|---|---|
| 第一次进这个项目 | 本文件 → `README.md` → `docs/architecture.md` |
| 改某块逻辑 | `docs/architecture.md` 的模块表，按路径直接跳源码，别全库乱读 |
| 行为看着不对、像有坑 | `docs/gotchas.md` |
| 想知道怎么验收 | 本文件「命令」一节 → `check.sh` |

## 命令

- 启动：`pnpm install && pnpm build` → `node scripts/install.mjs`（dry-run，只打印将写进 profile 的改动）→ 确认后加 `--apply` → 重启 dsh web（首次手动，之后点按钮）。可选 `node scripts/install.mjs --verify` 先在克隆副本里验证。完整步骤与确认方法见 `README.md`。
- 检查：`bash check.sh`（唯一判断对错的方式，别靠肉眼；底层是 `pnpm test`）。

## 维护

- 本文件 ≤ 80 行，只当路由器。细节写进 `docs/`，这里留指针。
- 改了某个模块，同批改 `docs/architecture.md` 对应那段。
- `check.sh` 只准加严：删断言、加 `|| true`、改 `exit 0` 都算作弊。
