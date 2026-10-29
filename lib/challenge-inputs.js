import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { requireDirectory, syncDirectory } from "./challenge-statement.js";
import { captureInputContext, inputError, requireInputOpen, requireInputWritable } from "./input-context.js";
import { downloadPlatformInputs, platformPreparationPatch, resolvePlatformAttachments } from "./platform-inputs.js";

export function createChallengeInputs({ store, preparation, platforms, resources, tasks, lifecycle,
	getCopyLimit = () => 50 * 1024 * 1024, maxStatementBytes = 2 * 1024 * 1024, maxFiles = 50 }) {
	let closed = false;
	const writable = () => requireInputWritable(store, closed);
	function normalizeInputs(rawFiles) {
		if (!Array.isArray(rawFiles) || rawFiles.length > maxFiles || rawFiles.some((value) => typeof value !== "string" || value.length > 8192))
			throw inputError("ATTACHMENT_LIMIT", `附件必须是字符串列表，最多 ${maxFiles} 项，每项不超过 8192 字符`);
		const inputs = rawFiles.map((value) => value.trim()).filter(Boolean).map((value) => /^https?:\/\//i.test(value) ? value : path.resolve(value));
		if (inputs.some((value) => value.length > 8192)) throw inputError("ATTACHMENT_LIMIT", "规范化后的附件来源超过 8192 字符");
		return inputs;
	}
	function copyLocalInputs(ch, rawFiles) {
		const kept = [], directory = path.join(ch.dir, "files"), copyLimit = Number(getCopyLimit());
		if (!Number.isFinite(copyLimit) || copyLimit <= 0) throw inputError("ATTACHMENT_LIMIT", "本地附件复制上限无效");
		preparation.check(ch); requireDirectory(directory);
		let copiedBytes = 0;
		for (const value of rawFiles) {
			if (/^https?:\/\//i.test(value)) {
				let name = value;
				try { name = path.basename(new URL(value).pathname) || value; } catch { /* keep reference */ }
				kept.push({ name, path: "", source: "url", url: value });
				continue;
			}
			const before = fs.statSync(value);
			if (!before.isFile()) throw inputError("ATTACHMENT_INVALID", "附件不是普通文件：" + value);
			if (before.size > copyLimit) { kept.push({ name: path.basename(value), path: value, source: "user", size: before.size, external: true }); continue; }
			copiedBytes += before.size;
			if (copiedBytes > copyLimit) throw inputError("ATTACHMENT_TOTAL_TOO_LARGE", "本次本地附件复制总大小超过上限");
			const name = path.basename(value).replace(/[^\w.\-]+/g, "_").slice(0, 120) || "file.bin";
			const dest = path.join(directory, `input-${crypto.randomUUID()}-${name}`);
			fs.copyFileSync(value, dest, fs.constants.COPYFILE_EXCL);
			try { fs.chmodSync(dest, 0o600); } catch { /* Windows/ACL */ }
			const fd = fs.openSync(dest, "r+");
			try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
			const after = fs.statSync(value);
			if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
				throw inputError("ATTACHMENT_CHANGED", "复制期间源附件发生变化：" + value);
			kept.push({ name: path.basename(value), path: dest, source: "user", size: before.size });
		}
		syncDirectory(directory);
		return kept;
	}
	function create(input, { baseDir, workspace = "", inputKind = "local" } = {}) {
		writable();
		if (!baseDir) throw inputError("INPUT_DIRECTORY_REQUIRED", "创建题目需要明确的目录上下文");
		if (!["local", "platform"].includes(inputKind)) throw inputError("PREPARATION_SOURCE_MISMATCH", "未知的题目输入来源");
		const title = String(input?.title ?? "").trim(), statement = String(input?.statement ?? "");
		if (!title) throw inputError("TITLE_REQUIRED", "title 必填");
		if (Buffer.byteLength(statement, "utf8") > maxStatementBytes) throw inputError("STATEMENT_TOO_LARGE", `题面超过上限（${maxStatementBytes} 字节）`);
		const rawFiles = normalizeInputs(input.files ?? []);
		if (inputKind === "platform" && rawFiles.length) throw inputError("PREPARATION_SOURCE_MISMATCH", "平台附件应通过下载流程准备");
		const ch = preparation.begin({ title, category: input.category ? String(input.category) : "", statement,
			hasContainer: input.hasContainer === true, requiresTarget: input.requiresTarget === true,
			target: input.target ? String(input.target) : "", platform: input.platform ?? null, dirBase: baseDir,
			...(workspace ? { workspace } : {}), maxAttempts: Number(input.maxAttempts) > 0 ? Number(input.maxAttempts) : undefined,
			timeBudgetMs: Number(input.timeBudgetMinutes) > 0 ? Number(input.timeBudgetMinutes) * 60 * 1000 : undefined }, { inputKind, inputs: rawFiles });
		try {
			preparation.ensureDirectory(ch);
			const autoRoot = path.dirname(ch.dir);
			if (path.basename(autoRoot) === ".ctf-auto") {
				try { fs.writeFileSync(path.join(autoRoot, ".gitignore"), "*\n", { encoding: "utf8", mode: 0o600, flag: "wx" }); }
				catch (error) { if (error.code !== "EEXIST") console.warn("[dsh-ctf-auto] workspace ignore file could not be created"); }
			}
			return inputKind === "platform" ? ch : preparation.complete(ch, copyLocalInputs(ch, rawFiles));
		} catch (error) {
			try { preparation.fail(ch, error); } catch { /* preserve primary failure */ }
			throw Object.assign(error, { id: ch.id, applied: true });
		}
	}
	async function retry(id, { files: replacement, scope } = {}) {
		let actor;
		try {
			const context = captureInputContext(scope);
			writable(); context.check();
			const original = store.get(id);
			if (original?.preparation?.phase === "ready") return { ok: true, id, alreadyReady: true, status: original.status };
			if (!original || !lifecycle(original).permissions.prepare) throw inputError("PREPARATION_NOT_RETRYABLE", "题目仍在准备、存在执行/验证记录或有资源待核对；files_ready 阶段请重试本地同步");
			const inputKind = original.preparation.inputKind || (original.platform ? "platform" : "local");
			let inputs, connection;
			if (inputKind === "local") {
				if (replacement == null && !Array.isArray(original.preparation.inputs)) throw inputError("PREPARATION_INPUTS_REQUIRED", "旧记录没有保存原始附件列表，请用 ctf_challenge_prepare 显式提供 files（确认无附件时传 []）");
				inputs = normalizeInputs(replacement ?? original.preparation.inputs);
			} else {
				if (replacement != null) throw inputError("PREPARATION_SOURCE_MISMATCH", "平台导入的输入需从原平台重新获取，不能用本地附件替换");
				connection = platforms.forChallenge(original);
				if (!connection.client) throw inputError(connection.code || "PLATFORM_UNAVAILABLE", connection.error);
				if (!String(original.platform?.challengeId || "").trim()) throw inputError("PLATFORM_CHALLENGE_INVALID", "题目缺少平台编号");
			}
			function check() {
				requireInputOpen(store, closed); context.check();
				const current = preparation.check(actor), usage = resources.status(current);
				if (usage.users || usage.cleanup || usage.blocked || usage.taskBlocked || usage.taskRecoveryPending || tasks.list(id).some((row) => row.unresolved))
					throw inputError("PREPARATION_RESOURCE_BUSY", "题目资源在准备期间被占用或需要核对");
				if (connection && platforms.forChallenge(current).sessionKey !== connection.sessionKey) throw inputError("STALE_PLATFORM_CONNECTION", "平台连接已切换，已停止旧输入准备");
			}
			actor = preparation.resume(original, { inputKind, inputs });
			check(); preparation.ensureDirectory(actor);
			let files, patch = {};
			if (inputKind === "local") files = copyLocalInputs(actor, inputs);
			else {
				const meta = original.platform;
				const response = await connection.client.getChallenge(meta.challengeId, { id: meta.challengeId, practice_ground_id: meta.groundId || "",
					source: { type: meta.sourceType || "practice", practice_ground_id: meta.groundId || "", competition_id: meta.competitionId || "", stage_id: meta.stageId || "" } });
				check();
				if (!response.ok) throw inputError(response.code || "PLATFORM_DETAIL_FAILED", response.error || "平台题面查询失败");
				const detail = structuredClone(response.data);
				patch = platformPreparationPatch(detail, { platformId: meta.challengeId, baseUrl: connection.baseUrl, title: original.title, category: original.category, maxStatementBytes });
				const rawFiles = await resolvePlatformAttachments({ platforms, connection, meta, detail, check });
				files = await downloadPlatformInputs({ challenge: actor, connection, rawFiles, check });
			}
			check();
			const ready = preparation.complete(actor, files, patch);
			return { ok: true, id, status: ready.status, files: ready.files.length };
		} catch (error) {
			if (actor) { try { preparation.fail(actor, error); } catch { /* preserve primary failure */ } }
			return { ok: false, id, code: error.code || "CHALLENGE_PREPARATION_FAILED", error: String(error.message || error), applied: !!actor || error.applied === true,
				...(error.persistence ? { persistence: error.persistence } : {}) };
		}
	}
	return { create, retry, close() { closed = true; } };
}
