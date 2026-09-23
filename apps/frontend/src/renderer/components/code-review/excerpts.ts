export interface LineSelection {
	start: number;
	end: number;
}
export function excerpt(content: string, selection?: LineSelection | null) {
	const lines = content.replace(/\r\n/g, "\n").split("\n");
	if (lines.at(-1) === "") lines.pop();
	const start = Math.max(
		1,
		Math.min(selection?.start ?? 1, Math.max(lines.length, 1)),
	);
	const end = Math.max(
		start,
		Math.min(selection?.end ?? lines.length, Math.max(lines.length, 1)),
	);
	return { start, end, code: lines.slice(start - 1, end).join("\n") };
}
export function excerptPatch(
	file: string,
	content: string,
	selection?: LineSelection | null,
) {
	const { start, code } = excerpt(content, selection);
	const lines = code.split("\n");
	return `diff --git a/${file} b/${file}\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +${start},${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}\n`;
}
export function excerptMarkdown(
	file: string,
	content: string,
	selection?: LineSelection | null,
) {
	const { start, end, code } = excerpt(content, selection);
	const fence = "`".repeat(
		Math.max(
			3,
			...Array.from(code.matchAll(/`+/g), (match) => match[0].length + 1),
		),
	);
	return `${file}:${start}-${end}\n\n${fence}\n${code}\n${fence}`;
}
