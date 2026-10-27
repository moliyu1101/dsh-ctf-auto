#!/usr/bin/env bash
# wsl_tool.sh —— 在 WSL 发行版里执行命令（把当前目录映射成 /mnt 路径）。
# 用法：bash wsl_tool.sh [distro] "<command>"
# 例：bash wsl_tool.sh Ubuntu "python3 -c 'import pwn; print(pwn.__version__)'"
set -euo pipefail

distro="${1:-Ubuntu}"
command="${2:-}"

if [ -z "$command" ]; then
  echo "用法：bash wsl_tool.sh [distro] \"<command>\"" >&2
  exit 2
fi

cwd_win="$(pwd)"
# C:\a\b -> /mnt/c/a/b
cwd_wsl="$(printf '%s' "$cwd_win" | sed -E 's|^([A-Za-z]):|/mnt/\L\1|; s|\\|/|g')"

exec wsl.exe -d "$distro" -- bash -lc "cd '$cwd_wsl' && $command"