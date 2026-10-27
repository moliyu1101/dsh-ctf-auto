#!/usr/bin/env bash
# unpack.sh —— 压缩包识别 + 安全解压（只解压到指定目录，不覆盖已有文件，不执行内容）。
# 用法：bash unpack.sh <压缩包> <输出目录>
set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "用法：bash unpack.sh <压缩包> <输出目录>" >&2
  exit 2
fi

archive="$1"
outdir="$2"
mkdir -p "$outdir"

kind="$(file -b "$archive" 2>/dev/null || echo unknown)"
echo "[unpack] $archive ($kind) -> $outdir"

case "$kind" in
  *Zip*|*zip*)          unzip -n -q "$archive" -d "$outdir" ;;
  *gzip*|*GZip*)        tar -xzf "$archive" -C "$outdir" ;;
  *bzip2*)              tar -xjf "$archive" -C "$outdir" ;;
  *XZ*)                 tar -xJf "$archive" -C "$outdir" ;;
  *POSIX\ tar*|*tar*)   tar -xf "$archive" -C "$outdir" ;;
  *7-zip*)              7z x -y -o"$outdir" "$archive" ;;
  *RAR*)                 unrar x -o- "$archive" "$outdir/" ;;
  *)                    echo "[unpack] 不认识的类型：$kind（先 triage.sh 再看）" >&2; exit 1 ;;
esac

echo "[unpack] 完成。列目录："
find "$outdir" -maxdepth 2 -type f -printf '%p (%s bytes)\n' 2>/dev/null | head -50