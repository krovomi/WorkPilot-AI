/**
 * What one line the insights runner prints means for the chat: text of the
 * answer, or a marker (a suggested task, a tool starting or ending, a Learning
 * Mode explanation). Read the same way for the runner started here
 * (`insights-executor.ts`) and for a server job's output (`server-insights.ts`).
 */

import type { InsightsStreamChunk } from "../../shared/types";

const MARKERS: ReadonlyArray<
	[string, (value: Record<string, unknown>) => InsightsStreamChunk | null]
> = [
	[
		"__TASK_SUGGESTION__:",
		(value) =>
			typeof value.title === "string"
				? {
						type: "task_suggestion",
						suggestedTask: value as InsightsStreamChunk["suggestedTask"],
					}
				: null,
	],
	[
		"__TOOL_START__:",
		(value) =>
			typeof value.name === "string"
				? {
						type: "tool_start",
						tool: {
							name: value.name,
							input: typeof value.input === "string" ? value.input : undefined,
						},
					}
				: null,
	],
	[
		"__TOOL_END__:",
		(value) =>
			typeof value.name === "string"
				? { type: "tool_end", tool: { name: value.name } }
				: null,
	],
	[
		"__EXPLANATION__:",
		(value) => ({
			type: "explanation",
			explanation: value as unknown as InsightsStreamChunk["explanation"],
		}),
	],
];

/**
 * The chunk a line makes, or null for a blank line or a marker that does not
 * parse (a marker is never shown as text).
 */
export function chunkForLine(line: string): InsightsStreamChunk | null {
	for (const [prefix, read] of MARKERS) {
		if (!line.startsWith(prefix)) continue;
		try {
			const value: unknown = JSON.parse(line.slice(prefix.length));
			return value && typeof value === "object" && !Array.isArray(value)
				? read(value as Record<string, unknown>)
				: null;
		} catch {
			return null;
		}
	}
	// A blank line is text too: it separates Markdown paragraphs and stays
	// inside code blocks. Dropping it glued the answer's paragraphs together.
	return { type: "text", content: `${line}\n` };
}

/**
 * Cut a process's output into whole lines. Output arrives in chunks that end
 * anywhere, mid-line included: `push` returns the lines a chunk completes and
 * keeps the rest for the next one, `flush` returns what is left at the end.
 */
export function createLineReader(): {
	push(text: string): string[];
	flush(): string[];
} {
	let pending = "";
	return {
		push(text) {
			const lines = (pending + text).split("\n");
			pending = lines.pop() ?? "";
			return lines.map((line) => line.replace(/\r$/, ""));
		},
		flush() {
			const rest = pending;
			pending = "";
			return rest ? [rest.replace(/\r$/, "")] : [];
		},
	};
}
