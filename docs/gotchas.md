# 坑

只追加，不整理。一条一行：什么情况下会踩 → 为什么 → 怎么绕。
整理过的坑会失真，宁可粗糙也别汇总成「注意事项」。

- 自拉起写成 `dsh web --profile web ...` → `error: option '--profile <name>' argument 'web' is invalid. select a profile only once`，web 根本起不来 → 位置参数和 `--profile` 是同一个设置的两种写法，只能选一种；helper 自拉起用 `dsh --profile <name> --port <port> --no-open`。
- `dsh-daemon restart` 在「距上次启动 <15s」时打印 `restart skipped` 并以 0 退出，旧 web 一直活着 → 只看退出码会把「没重启」当成功 → helper 必须自己观察 `/health` 先掉后回；退出码 0 且端口没掉按跳过处理（返回 1）。
