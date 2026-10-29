export const inputError = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });

// The host owns authorization. Capture its synchronous guard before queueing;
// services invoke it again after awaits and before installing visible results.
export function captureInputContext(scope) {
	if (!scope || typeof scope.check !== "function") throw inputError("INPUT_SCOPE_REQUIRED", "输入操作缺少可信工作区上下文");
	const guard = scope.check;
	return Object.freeze({ workspace: String(scope.workspace || ""), baseDir: String(scope.baseDir || ""), driverSession: String(scope.driverSession || ""),
		check() {
			const result = guard();
			if (result && typeof result.then === "function") {
				Promise.resolve(result).catch(() => {});
				throw inputError("ASYNC_INPUT_SCOPE", "输入操作的授权检查必须同步完成");
			}
			if (result?.ok !== true) throw inputError(result?.code || "INPUT_SCOPE_DENIED", result?.error || "输入操作的工作区授权已失效");
		}
	});
}

export function requireInputOpen(store, closed) {
	if (closed || store.persistenceStatus().closed) throw inputError("INPUT_SERVICE_CLOSED", "输入服务已关闭，已停止旧操作");
}

export function requireInputWritable(store, closed) {
	requireInputOpen(store, closed);
	const writable = store.checkWritable();
	if (!writable.ok) throw inputError(writable.code, writable.error);
	if (store.persistenceStatus().dirty) throw inputError("STATE_NOT_DURABLE", "状态尚未保存，已暂停输入操作");
}
