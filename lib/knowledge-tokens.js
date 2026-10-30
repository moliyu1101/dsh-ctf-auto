export function tokenOccurrences(query) {
	const parts = String(query ?? "").normalize("NFKC").toLowerCase().match(/[\p{Script=Han}]+|[a-z0-9]+(?:[_.:-][a-z0-9]+)*/gu) || [];
	const tokens = [];
	for (const part of parts) {
		if (/^\p{Script=Han}+$/u.test(part) && part.length > 1) {
			for (let i = 0; i < part.length - 1; i++) tokens.push(part.slice(i, i + 2));
		} else tokens.push(part);
	}
	return tokens;
}
export const tokenize = (query) => [...new Set(tokenOccurrences(query))];
