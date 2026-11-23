# dsh-restart

给自己用的 DSH 插件：给 dsh web 加一个 `dsh_restart` 工具，替代每次手动停掉再拉起 dsh web 进程。

## 跑起来

```bash
pnpm install && pnpm build
node scripts/install.mjs          # dry-run；确认后加 --apply，再重启 dsh web 生效
```

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
