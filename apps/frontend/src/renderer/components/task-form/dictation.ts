export function appendTranscript(current: string, incoming: string): string {
	return incoming.trim()
		? `${current}${current && !/\s$/.test(current) ? " " : ""}${incoming.trim()}`
		: current;
}

export function appendDictation(
	before: string,
	draft: string,
	richText: boolean,
) {
	const text = draft.trim();
	const escaped = text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/\n/g, "<br>");
	return {
		before,
		after: text
			? before +
				(richText ? `<p>${escaped}</p>` : `${before ? "\n\n" : ""}${text}`)
			: before,
	};
}

export function undoDictation(
	current: string,
	insertion: { before: string; after: string },
): string | null {
	return current === insertion.after ? insertion.before : null;
}
