// Wrapper equivalence is used for the candidate ledger, never as proof of acceptance.
export function flagContent(value, wrapper = "") {
	let text = String(value || "").trim();
	for (let n = 0; n < 4; n++) {
		const match = /^([A-Za-z][\w-]*)\{([\s\S]*)\}$/.exec(text);
		if (!match || !["flag", "ctf", String(wrapper).toLowerCase()].includes(match[1].toLowerCase())) break;
		text = match[2];
	}
	return text;
}

export function flagCandidates(value, wrapper) {
	const original = String(value || "").trim();
	if (!wrapper || !/^[A-Za-z][\w-]*$/.test(wrapper)) return [original];
	const inner = flagContent(original, wrapper);
	return [...new Set([original, `${wrapper}{${inner}}`, inner])].filter((item) => item && item.length <= 300);
}

export const usableCandidate = (flag) => !!flag && flag.rejected !== true && (flag.verified === true || flag.localVerified === true);
export const acceptedFlag = (challenge, flag) => !!flag && flag.rejected !== true && flag.verified === true
	&& (!challenge.platform || flag.method === "platform" || flag.reviewed === true);
