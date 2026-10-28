// Observe exactly one executor completion. Missing or rejected observations do
// not prove that the remote worker stopped.
export function observeExecutorActivation(activation, { onUnknown = () => {} } = {}) {
	let sessionId = "", completion = null, error = null;
	function uncertain(message) {
		onUnknown(message);
		return Object.assign(new Error(message), { code: "EXECUTOR_OUTCOME_UNKNOWN" });
	}
	try {
		const childId = activation?.childId;
		if (typeof childId === "string" || typeof childId === "number" && Number.isFinite(childId)) sessionId = String(childId).trim();
		const pending = activation?.result;
		if (pending && typeof pending.then === "function") {
			let invalidResult = false;
			completion = Promise.resolve(pending).then((result) => {
				try {
					if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("invalid result");
					const stopReason = result.stopReason;
					if (typeof stopReason !== "string" || !stopReason.trim()) throw new Error("invalid stop reason");
					return { stopReason: stopReason.trim(), output: result.output, diagnostic: result.diagnostic };
				} catch { invalidResult = true; throw new Error("invalid executor result"); }
			}).catch(() => { throw uncertain(invalidResult ? "执行端结束回执格式无效，无法确认任务已经结束" : "等待执行端结束的 Promise 被拒绝，无法确认远端已经停止"); });
			completion.catch(() => {});
		}
		if (!sessionId || !completion) error = uncertain("执行端句柄缺少有效会话或完成 Promise，无法确认远端状态");
	} catch {
		error = uncertain("读取执行端句柄失败，无法确认远端状态");
	}
	return { sessionId, completion, error };
}
