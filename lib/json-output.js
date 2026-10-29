// Host tool transports require actual JSON values (including nested properties).
export function jsonOutput(value) {
	return JSON.parse(JSON.stringify(value ?? null, (_key, item) => {
		if (typeof item === "number" && !Number.isFinite(item)) return null;
		if (typeof item === "bigint") return item.toString();
		return item;
	}));
}
