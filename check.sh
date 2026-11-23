#!/bin/sh
# 一条命令判断对不对。绿 = 全部通过，红 = 有东西坏了。
# ①②③ 是骨架自带的；④ 是测试、构建与运行期依赖断言。
cd "$(dirname "$0")" || exit 1
fail=0
bad() { printf '✗ %s\n' "$1" >&2; fail=1; }

# ① AGENTS.md 是热缓存，超过 80 行就开始侵蚀注意力
if [ -f AGENTS.md ]; then
  n=$(wc -l < AGENTS.md | tr -d ' ')
  [ "$n" -gt 80 ] && bad "AGENTS.md 有 ${n} 行，超过 80 行上限，细节挪进 docs/ 并留指针"
fi

# ② 文档里点过名的路径必须真实存在
# 待补全标记里的例子不算「文档点了名」，跳过那些行
for p in $(grep -rhE '(src|tests|docs|specs)/[A-Za-z0-9_./-]+' AGENTS.md docs specs 2>/dev/null | grep -v '待补全' | grep -v '例：' | grep -oE '(src|tests|docs|specs)/[A-Za-z0-9_./-]+' | sort -u); do
  case "$p" in
    */) continue ;;                                   # 目录引用，不查
    *xxx*|*XXX*|*YYYY*|*NNN*|*slug*|*...*) continue ;;  # 模板里的示例路径，不查
  esac
  [ -e "$p" ] || bad "文档引用了不存在的路径: ${p}"
done

# ③ change 做完了却没归档
for t in specs/changes/*/tasks.md; do
  [ -f "$t" ] || continue
  case "$t" in */archive/*) continue ;; esac
  if grep -q '^- \[x\]' "$t" && ! grep -q '^- \[ \]' "$t"; then
    bad "${t} 全部勾完却没挪进 specs/changes/archive/"
  fi
done

# ④ 测试 / 验收命令
pnpm test || bad "测试失败"

# 构建 + 运行期依赖断言：产物必须是零宿主依赖（源码里的包名字符串不算 import）
pnpm build || bad "构建失败"
if [ ! -f lib/index.js ]; then
  bad "构建失败：lib/index.js 不存在"
else
  if grep -Eq "(^|[^A-Za-z0-9_$])(from|import|require)[[:space:]]*\(?[[:space:]]*[\"']@deepseek-ai/" lib/index.js; then
    bad "lib/index.js 里出现对 @deepseek-ai/* 的 import/require（运行期必须零宿主依赖）"
  fi
  for name in dsh_restart_precheck dsh_restart; do
    grep -q "$name" lib/index.js || bad "lib/index.js 里找不到工具名: $name"
  done
fi

if [ "$fail" -eq 0 ]; then echo '✓ 全部通过'; else echo '✗ 有未通过项' >&2; fi
exit "$fail"
