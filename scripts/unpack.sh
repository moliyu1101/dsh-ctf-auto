#!/usr/bin/env bash
# unpack.sh —— 压缩包识别 + 安全解压（拒绝绝对路径/..，尽量跳过已有文件，不执行内容）。
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

check_member() {
  case "$1" in
    /*|../*|*/../*|*/..) echo "[unpack] 拒绝不安全路径：$1" >&2; return 1 ;;
  esac
  return 0
}

list_members() {
  case "$kind" in
    *Zip\ archive*|*zip\ archive*) unzip -Z1 "$archive" ;;
    *gzip*|*GZip*|*bzip2*|*XZ*|*POSIX*|*tar*) tar -tf "$archive" ;;
    *7-zip*) 7z l -slt "$archive" | sed -n 's/^Path = //p' ;;
    *RAR*) unrar lb "$archive" ;;
  esac
}

members=""
case "$kind" in
  *Zip\ archive*|*zip\ archive*|*gzip*|*GZip*|*bzip2*|*XZ*|*POSIX*|*tar*|*7-zip*|*RAR*)
    members="$(list_members)" || { echo "[unpack] 无法列出归档成员，拒绝解压" >&2; exit 1; }
    ;;
esac
if [ -n "$members" ]; then
  while IFS= read -r member; do
    [ -z "$member" ] && continue
    check_member "$member" || exit 1
  done <<EOF
$members
EOF
fi

case "$kind" in
  *Zip\ archive*|*zip\ archive*) unzip -n -q "$archive" -d "$outdir" ;;
  *gzip*|*GZip*)        tar -xzkf "$archive" -C "$outdir" ;;
  *bzip2*)              tar -xjkf "$archive" -C "$outdir" ;;
  *XZ*)                 tar -xkf "$archive" -C "$outdir" ;;
  *POSIX\ tar*|*tar*)   tar -xkf "$archive" -C "$outdir" ;;
  *7-zip*)              7z x -aos -y -o"$outdir" "$archive" ;;
  *RAR*)                 unrar x -o- "$archive" "$outdir/" ;;
  *)                    echo "[unpack] 不认识的类型：$kind（先 triage.sh 再看）" >&2; exit 1 ;;
esac

echo "[unpack] 完成。列目录："
find "$outdir" -maxdepth 2 -type f -print 2>/dev/null | head -50
