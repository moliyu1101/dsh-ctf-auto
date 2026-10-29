import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export function statementMarkdown(ch) {
	const lines = [`# ${ch.title}`, ""];
	if (ch.category) lines.push(`- 模块：${ch.category}`);
	if (ch.target) lines.push(`- 目标：${ch.target}`);
	if (ch.platform) lines.push(`- 平台：${JSON.stringify(ch.platform)}`);
	lines.push("", "## 题面", "", ch.statement || "（未提供题面）", "");
	if (ch.files?.length) {
		lines.push("## 附件", "");
		for (const f of ch.files) lines.push(`- ${f.name}${f.path ? ` → \`${f.path}\`` : f.url ? ` → ${f.url}` : ""}`);
		lines.push("");
	}
	lines.push("## 工作区协议", "",
		"- 只在本题目录内读写：`notes.md`（发现/假设/结论随做随记）、`scripts/`、`artifacts/`、`files/`；",
		"- 验证通过的 flag 写 `flag.json`：`{\"flag\":\"...\",\"evidence\":\"...\",\"verified\":true}`；",
		"- 完成后必须调用 `ctf_flag_record`（id, flag, evidence, verified, method）登记；未解也要写清卡点与已试路径。", "");
	return lines.join("\n");
}

export function syncDirectory(dir) {
	if (process.platform === "win32") return;
	const fd = fs.openSync(dir, "r");
	try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

export function requireDirectory(dir) {
	const stat = fs.lstatSync(dir);
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw Object.assign(new Error("题目路径必须是普通目录"), { code: "CHALLENGE_DIRECTORY_INVALID" });
}

export function statementFileRevision(dir) {
	try {
		const stat = fs.lstatSync(path.join(dir, "statement.md"));
		if (!stat.isFile() || stat.isSymbolicLink()) throw Object.assign(new Error("statement.md 不是普通文件，已保留原路径"), { code: "STATEMENT_FILE_INVALID" });
		return JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]);
	} catch (error) { if (error.code === "ENOENT") return "missing"; throw error; }
}

export function synchronizeStatement(challenge) {
	requireDirectory(challenge.dir);
	const file = path.join(challenge.dir, "statement.md"), temporary = `${file}.tmp-${crypto.randomUUID()}`;
	statementFileRevision(challenge.dir);
	try {
		const fd = fs.openSync(temporary, "wx", 0o600);
		try { fs.writeFileSync(fd, statementMarkdown(challenge), "utf8"); fs.fsyncSync(fd); }
		finally { fs.closeSync(fd); }
		fs.renameSync(temporary, file); syncDirectory(challenge.dir);
	} finally { try { fs.rmSync(temporary, { force: true }); } catch { /* preserve primary error */ } }
}
