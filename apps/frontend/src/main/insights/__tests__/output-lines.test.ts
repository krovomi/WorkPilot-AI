/**
 * The insights runner's output, line by line: answer text, or one of its
 * markers. A marker that does not parse is dropped, never shown as text.
 */

import { describe, expect, it } from "vitest";
import { chunkForLine } from "../output-lines";

describe("insights output lines", () => {
	it("reads text and markers", () => {
		expect(chunkForLine("Hello")).toEqual({ type: "text", content: "Hello\n" });
		expect(chunkForLine("   ")).toBeNull();
		expect(
			chunkForLine('__TASK_SUGGESTION__:{"title":"Add tests","description":"x"}'),
		).toEqual({
			type: "task_suggestion",
			suggestedTask: { title: "Add tests", description: "x" },
		});
		expect(chunkForLine('__TOOL_START__:{"name":"Grep","input":"auth"}')).toEqual({
			type: "tool_start",
			tool: { name: "Grep", input: "auth" },
		});
		expect(chunkForLine('__TOOL_END__:{"name":"Grep"}')).toEqual({
			type: "tool_end",
			tool: { name: "Grep" },
		});
		expect(chunkForLine('__EXPLANATION__:{"title":"Why"}')).toEqual({
			type: "explanation",
			explanation: { title: "Why" },
		});
	});

	it("drops a marker that does not parse", () => {
		expect(chunkForLine("__TOOL_START__:not json")).toBeNull();
		expect(chunkForLine("__TASK_SUGGESTION__:[1,2]")).toBeNull();
		expect(chunkForLine('__TASK_SUGGESTION__:{"description":"no title"}')).toBeNull();
	});
});
