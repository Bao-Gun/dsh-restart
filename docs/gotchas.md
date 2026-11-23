# 坑

只追加，不整理。一条一行：什么情况下会踩 → 为什么 → 怎么绕。
整理过的坑会失真，宁可粗糙也别汇总成「注意事项」。

- 自拉起写成 `dsh web --profile web ...` → `error: option '--profile <name>' argument 'web' is invalid. select a profile only once`，web 根本起不来 → 位置参数和 `--profile` 是同一个设置的两种写法，只能选一种；helper 自拉起用 `dsh --profile <name> --port <port> --no-open`。
- `dsh-daemon restart` 在「距上次启动 <15s」时打印 `restart skipped` 并以 0 退出，旧 web 一直活着 → 只看退出码会把「没重启」当成功 → helper 必须自己观察 `/health` 先掉后回；退出码 0 且端口没掉按跳过处理（返回 1）。
- 冒烟只克隆 `~/.dsh/profiles/web` 这一层 → home 级 `.env` / `settings.yaml` / `plugins` / `daemon` 不在临时 DSH_HOME 里，真实启动依赖这些时结果会假红或假绿 → 失败信息统一带「仅克隆 profile 层」，别把冒烟当成完整启动验证。
- 宿主被杀会留下 `dsh-smoke-*` 临时目录，里面的 `dsh.pid` 数字可能已被无关进程复用（macOS 终端常为组长），照着数字 `kill -pid` 会误杀 → 另存 `dsh.json` 的 pid + lstart + command，清扫时逐项比对，任何一项无法确认就只删目录、不发信号。

