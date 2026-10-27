#!/usr/bin/env python3
"""flag_check.py —— 校验 flag 形态，可选调用题目自带 checker。

用法：
  python flag_check.py "CTF{abc}"                          # 只做形态校验
  python flag_check.py "CTF{abc}" --checker "python check.py"   # 形态 + 本地 checker
  python flag_check.py "CTF{abc}" --pattern "^CTF\\{[^}]+\\}$"

退出码：0=通过，1=不通过（便于脚本串接）。"""
import argparse
import re
import shlex
import subprocess
import sys

DEFAULT_PATTERN = r"^[A-Za-z0-9_]{2,40}\{[^}\n]{1,200}\}$"


def check_format(flag: str, pattern: str) -> tuple[bool, str]:
    if not flag:
        return False, "flag 为空"
    if "\n" in flag or "\r" in flag:
        return False, "flag 含换行"
    if len(flag) > 300:
        return False, "flag 过长（>300）"
    try:
        if not re.match(pattern, flag):
            return False, f"不符合形态 {pattern}"
    except re.error as exc:
        return False, f"正则非法：{exc}"
    return True, "形态 OK"


def run_checker(checker: str, flag: str) -> tuple[bool, str]:
    command = f"{checker} {shlex.quote(flag)}"
    try:
        proc = subprocess.run(command, shell=True, capture_output=True, text=True, timeout=120)
    except subprocess.TimeoutExpired:
        return False, "checker 超时（120s）"
    output = (proc.stdout or "") + (proc.stderr or "")
    return proc.returncode == 0, output.strip()[:2000]


def main() -> int:
    parser = argparse.ArgumentParser(description="flag 形态/checker 校验")
    parser.add_argument("flag", help="待校验的 flag")
    parser.add_argument("--pattern", default=DEFAULT_PATTERN, help="形态正则")
    parser.add_argument("--checker", default="", help="本地 checker 命令（会把 flag 作为第一个参数）")
    args = parser.parse_args()

    ok, message = check_format(args.flag, args.pattern)
    print(f"[format] {'OK' if ok else 'FAIL'}: {message}")
    if not ok:
        return 1
    if args.checker:
        ok2, out = run_checker(args.checker, args.flag)
        print(f"[checker] {'OK' if ok2 else 'FAIL'}\n{out}")
        return 0 if ok2 else 1
    return 0


if __name__ == "__main__":
    sys.exit(main())