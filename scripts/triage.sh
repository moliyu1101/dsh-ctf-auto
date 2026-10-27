#!/usr/bin/env bash
# triage.sh —— 附件快速分诊：类型/大小/十六进制头/可见字符串（只读）。
# 用法：bash triage.sh <文件或目录> [...]
set -uo pipefail

if [ "$#" -eq 0 ]; then
  echo "用法：bash triage.sh <文件或目录> [...]" >&2
  exit 2
fi

for target in "$@"; do
  if [ -d "$target" ]; then
    find "$target" -maxdepth 2 -type f -printf '%p\n' 2>/dev/null | while read -r file; do
      printf '\n=== %s ===\n' "$file"
      printf 'size: %s bytes\n' "$(wc -c <"$file" 2>/dev/null || echo 0)"
      printf 'type: %s\n' "$(file -b "$file" 2>/dev/null || echo unknown)"
      printf 'head: '; od -An -tx1 -N16 "$file" 2>/dev/null | tr -s ' ' | head -c 120; echo
      strings -n 6 "$file" 2>/dev/null | head -10
    done
    continue
  fi
  if [ -f "$target" ]; then
    printf '\n=== %s ===\n' "$target"
    printf 'size: %s bytes\n' "$(wc -c <"$target" 2>/dev/null || echo 0)"
    printf 'type: %s\n' "$(file -b "$target" 2>/dev/null || echo unknown)"
    printf 'head: '; od -An -tx1 -N16 "$target" 2>/dev/null | tr -s ' ' | head -c 120; echo
    strings -n 6 "$target" 2>/dev/null | head -15
  fi
done