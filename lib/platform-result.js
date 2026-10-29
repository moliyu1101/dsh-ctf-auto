// Transport success is not proof that a submitted flag was accepted.
export function submissionStatus(data = {}) {
	const raw = String(data.status || data.result || data.message || "").trim();
	const lower = raw.toLowerCase();
	if (data.already_solved === true || /already|solved_before|duplicate/.test(lower)) return "already_solved";
	if (data.correct === false || data.is_correct === false || data.accepted === false || /incorrect|wrong|rejected|not[ _-]?(correct|accepted|right)/.test(lower)) return "incorrect";
	if (data.correct === true || data.is_correct === true || data.accepted === true || /^(correct|success|accepted|right)$/.test(lower)) return "correct";
	return raw || "unknown";
}

// Retain only bounded diagnostic fields; never persist whole responses, headers
// or credentials just to explain an otherwise empty submission message.
export function submissionDiagnostic(response = {}) {
	const data = response.data || {}, raw = data.raw || data;
	const diagnostic = {};
	for (const [key, value] of Object.entries({ httpStatus: response.httpStatus, code: raw.code ?? response.code,
		rawStatus: data.rawStatus ?? raw.status ?? raw.result ?? response.status,
		correct: raw.correct, is_correct: raw.is_correct, accepted: raw.accepted })) {
		if (typeof value === "string") diagnostic[key] = value.slice(0, 200);
		else if (typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) diagnostic[key] = value;
	}
	return diagnostic;
}
