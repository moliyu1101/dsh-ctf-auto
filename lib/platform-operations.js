// Coordinate in-process platform operations without retrying remote side effects.
export function createPlatformOperations({ maxPending = 128 } = {}) {
	const tails = new Map(), flights = new Map(), latest = new Map();
	let pending = 0, closed = false;
	const unavailable = () => Object.assign(new Error(closed ? "平台服务已关闭" : "平台操作队列已满，请稍后重试"), { code: closed ? "PLATFORM_CLOSED" : "PLATFORM_BUSY" });

	function exclusive(resource, operation) {
		if (closed || pending >= maxPending) return Promise.reject(unavailable());
		pending++;
		const previous = tails.get(resource) || Promise.resolve();
		const job = previous.catch(() => {}).then(() => {
			if (closed) throw unavailable();
			return operation();
		});
		const tail = job.then(() => {}, () => {});
		tails.set(resource, tail);
		return job.finally(() => {
			pending--;
			if (tails.get(resource) === tail) tails.delete(resource);
		});
	}

	function singleFlight(key, operation) {
		if (closed) return Promise.reject(unavailable());
		if (flights.has(key)) return flights.get(key);
		const job = Promise.resolve().then(operation).finally(() => {
			if (flights.get(key) === job) flights.delete(key);
		});
		flights.set(key, job);
		return job;
	}

	// Only adjacent identical mutations share a result. A different queued action
	// creates a barrier (start -> delete -> start must preserve all three).
	function coalesced(resource, key, operation) {
		const previous = latest.get(resource);
		if (!closed && previous?.key === key) return previous.job;
		const marker = { key, job: null };
		marker.job = exclusive(resource, operation).finally(() => {
			if (latest.get(resource) === marker) latest.delete(resource);
		});
		latest.set(resource, marker);
		return marker.job;
	}

	return {
		exclusive, singleFlight, coalesced,
		snapshot: () => ({ pending, resources: tails.size, shared: flights.size, maxPending, closed }),
		close() { closed = true; }
	};
}
