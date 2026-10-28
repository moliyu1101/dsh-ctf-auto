// Transport success is not proof that a submitted flag was accepted.
export function submissionStatus(data = {}) {
	const raw = String(data.status || data.result || data.message || "").trim();
	const lower = raw.toLowerCase();
	if (data.already_solved === true || /already|solved_before|duplicate/.test(lower)) return "already_solved";
	if (data.correct === false || data.is_correct === false || data.accepted === false || /incorrect|wrong|fail|error|not[ _-]?(correct|accepted|right)/.test(lower)) return "incorrect";
	if (data.correct === true || data.is_correct === true || data.accepted === true || /^(correct|success|accepted|right)$/.test(lower)) return "correct";
	return raw || "incorrect";
}
