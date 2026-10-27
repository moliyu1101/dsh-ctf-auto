// dsh-ctf-auto / lib/wslrun.js —— WSL 工具转发（Windows 宿主 → WSL 发行版执行命令）。
//
// 目标：pwn/逆向/取证很多工具链在 WSL 里（pwntools、gdb、binwalk…）。本模块提供：
//   - Windows ↔ WSL 路径换算
//   - 命令/参数拼装（单引号安全转义）
//   - 执行封装（可注入 execImpl 便于测试）
// 纯函数与执行分层：路径/拼装可在无 WSL 的机器上测。

import { execFile } from "node:child_process";

/** Windows 路径转 WSL 路径：C:\\a\\b → /mnt/c/a/b；已是 / 开头则原样（规范化反斜杠）。 */
export function toWslPath(winPath) {
	const value = String(winPath == null ? "" : winPath).trim();
	if (!value) return "";
	if (value.startsWith("/")) return value.replace(/\\/g, "/");
	const drive = /^([A-Za-z]):[\\/]?(.*)$/.exec(value);
	if (!drive) return value.replace(/\\/g, "/");
	const rest = drive[2].replace(/\\/g, "/").replace(/^\/+/, "");
	return `/mnt/${drive[1].toLowerCase()}/${rest}`.replace(/\/+$/, "") || `/mnt/${drive[1].toLowerCase()}`;
}

/** 单引号转义（用于 bash -lc 脚本里的路径/参数）。 */
export function shellQuote(value) {
	return `'${String(value == null ? "" : value).replace(/'/g, `'\\''`)}'`;
}

/**
 * 拼装 wsl.exe 参数。
 * @param {{distro?:string, command:string, cwd?:string}} options
 * @returns {string[]}
 */
export function buildWslArgs(options = {}) {
	const distro = String(options.distro || "Ubuntu").trim() || "Ubuntu";
	const command = String(options.command || "").trim();
	const cwd = toWslPath(options.cwd);
	const script = cwd ? `cd ${shellQuote(cwd)} && ${command}` : command;
	return ["-d", distro, "--", "bash", "-lc", script];
}

/**
 * 在 WSL 里执行命令。
 * @param {{distro?:string, command:string, cwd?:string, timeoutMs?:number, maxOutput?:number, execImpl?:Function}} options
 * @returns {Promise<{ok:boolean, exitCode:number, stdout:string, stderr:string, durationMs:number, truncated:boolean, distro:string, command:string, args:string[]}>}
 */
export function runWslCommand(options = {}) {
	const opts = options && typeof options === "object" ? options : {};
	const distro = String(opts.distro || "Ubuntu").trim() || "Ubuntu";
	const command = String(opts.command || "").trim();
	const maxOutput = Math.max(1000, Number(opts.maxOutput) || 200000);
	const timeoutMs = Math.max(1000, Number(opts.timeoutMs) || 120000);
	const execImpl = typeof opts.execImpl === "function" ? opts.execImpl : execFile;
	const args = buildWslArgs({ distro, command, cwd: opts.cwd });
	const started = Date.now();
	return new Promise((resolve) => {
		if (!command) {
			resolve({ ok: false, exitCode: -1, stdout: "", stderr: "命令为空", durationMs: 0, truncated: false, distro, command, args });
			return;
		}
		let settled = false;
		const finish = (payload) => {
			if (settled) return;
			settled = true;
			const stdout = String(payload.stdout || "");
			const stderr = String(payload.stderr || "");
			const truncated = stdout.length > maxOutput || stderr.length > maxOutput;
			resolve({
				ok: payload.exitCode === 0,
				exitCode: payload.exitCode == null ? -1 : Number(payload.exitCode),
				stdout: stdout.slice(0, maxOutput),
				stderr: stderr.slice(0, maxOutput),
				durationMs: Date.now() - started,
				truncated,
				distro,
				command,
				args
			});
		};
		try {
			execImpl(
				"wsl",
				args,
				{ timeout: timeoutMs, windowsHide: true, maxBuffer: maxOutput * 2, encoding: "utf8" },
				(error, stdout, stderr) => {
					if (error) {
						finish({
							exitCode: typeof error.code === "number" ? error.code : error.killed ? 124 : -1,
							stdout: stdout || "",
							stderr: [stderr || "", String(error.message || error)].filter(Boolean).join("\n")
						});
						return;
					}
					finish({ exitCode: 0, stdout, stderr });
				}
			);
		} catch (error) {
			finish({ exitCode: -1, stdout: "", stderr: String((error && error.message) || error) });
		}
	});
}

/** 解析 `wsl -l -q` 输出（UTF-16LE 交错 \0 或 UTF-8 均可）。 */
function parseDistroList(raw) {
	const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw || ""), "utf8");
	const text = buf.length > 2 && buf[1] === 0 ? buf.toString("utf16le") : buf.toString("utf8");
	return text
		.replace(/\u0000/g, "")
		.split(/\r?\n/)
		.map((line) => line.replace(/[^\x20-\x7e\u4e00-\u9fff-]/g, "").trim())
		.filter(Boolean);
}

/** 列出已安装的 WSL 发行版；逐级回退（列表 → 绝对路径 → 默认发行版实际执行）。 */
export function listDistros(options = {}) {
	const execImpl = typeof options.execImpl === "function" ? options.execImpl : execFile;
	return new Promise((resolve) => {
		let settled = false;
		const finish = (value) => { if (!settled) { settled = true; resolve(Array.isArray(value) && value.length ? value : []); } };
		const probe = () => {
			runWslCommand({ distro: "Ubuntu", command: 'echo "$WSL_DISTRO_NAME"', timeoutMs: 20000, execImpl })
				.then((result) => {
					const name = String(result.stdout || "").replace(/\u0000/g, "").trim();
					finish(result.ok && name ? [name] : []);
				})
				.catch(() => finish([]));
		};
		const tryList = (bin, attempt) => {
			try {
				execImpl(bin, ["-l", "-q"], { encoding: "utf8", timeout: 15000, windowsHide: true }, (error, stdout) => {
					if (error) { attempt(); return; }
					const names = parseDistroList(stdout);
					if (names.length > 0) { finish(names); return; }
					attempt();
				});
			} catch { attempt(); }
		};
		tryList("wsl", () => {
			const systemRoot = process.env.SystemRoot || process.env.windir || "C:\\Windows";
			tryList(systemRoot + "\\System32\\wsl.exe", probe);
		});
	});
}

export default { toWslPath, shellQuote, buildWslArgs, runWslCommand, listDistros };