# 脚本库（工具层）

本目录预置一批「题目无关」的小工具，子代理可直接调用（路径：插件根 `scripts/`）。
所有脚本只做只读分析/格式校验，不联网、不破坏目标。

| 脚本 | 用途 | 用法 |
|---|---|---|
| `flag_check.py` | flag 形态校验 + 可选调用本地 checker | `python flag_check.py "CTF{x}" --checker "python check.py"` |
| `triage.sh` | 附件快速分诊（file/strings/十六进制头） | `bash triage.sh ./files` |
| `unpack.sh` | 压缩包识别与安全解压（不覆盖、不执行） | `bash unpack.sh ./files/a.zip ./out` |
| `wsl_tool.sh` | 在 WSL 里跑 Linux 工具链（pwntools/gdb/binwalk） | `bash wsl_tool.sh Ubuntu "python3 -c 'print(1)'"` |

约定：
- 新脚本放本目录并在上表登记；脚本必须幂等、默认只读、输出到 stdout。
- 需要写文件时写到当前工作目录的 `artifacts/` 下，不写系统路径。
- 不把 flag/token 写进脚本或日志。