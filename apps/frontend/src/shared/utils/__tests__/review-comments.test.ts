import { describe, expect, it } from "vitest";
import type { ReviewComment } from "../../types/review-comments";
import {
	checkCommentInput,
	cleanCommentText,
	excerptAround,
	fixRequestSection,
	locateComment,
	parseCommentCopies,
	safeRelativePath,
	serializeComments,
} from "../review-comments";

const FILE = ["class OrderService {", "  total(order) {", "    return order.items.sum();", "  }", "}"];

function comment(over: Partial<ReviewComment> = {}): ReviewComment {
	return {
		id: "c1",
		path: "src/OrderService.ts",
		side: "new",
		line: 3,
		commit: "abc1234",
		excerpt: FILE.slice(1, 4),
		excerptOffset: 1,
		text: "Handle a null order",
		status: "open",
		createdAt: "2026-11-06T10:00:00Z",
		updatedAt: "2026-11-06T10:00:00Z",
		addressedSession: null,
		...over,
	};
}

describe("what the renderer may send", () => {
	it.each([["../etc/passwd"], ["/etc/passwd"], ["C:\\\\Windows\\\\x"], ["a//b"], [""], [42]])(
		"refuses the path %j",
		(p) => {
			expect(safeRelativePath(p)).toBeNull();
			expect(checkCommentInput({ path: p, line: 1, text: "x" })).toEqual({ ok: false, error: "invalid_path" });
		},
	);

	it("refuses a bad line, an empty text and a commit that is not a hash", () => {
		expect(checkCommentInput({ path: "a.ts", line: 0, text: "x" })).toEqual({ ok: false, error: "invalid_line" });
		expect(checkCommentInput({ path: "a.ts", line: 2, text: " \u200b " })).toEqual({ ok: false, error: "empty_comment" });
		expect(checkCommentInput({ path: "a.ts", line: 2, text: "x", commit: "HEAD~1" })).toEqual({
			ok: false,
			error: "invalid_commit",
		});
		expect(checkCommentInput({ path: ".\\src\\a.ts", line: 2, text: " fix \u0007" })).toEqual({
			ok: true,
			input: { path: "src/a.ts", side: "new", line: 2, text: "fix", commit: undefined },
		});
	});
});

describe("the person's text", () => {
	it("drops control and invisible characters, keeps tabs and line breaks", () => {
		const raw = `  a\u0000b\u0007c\td\ne\r\u007ff\u200bg\u202eh\u2062i\ufeffj  `;
		expect(cleanCommentText(raw)).toBe("abc\td\ne\rfghij");
	});

	it("is bounded and never throws on a non-string", () => {
		expect(cleanCommentText("x".repeat(5000))).toHaveLength(4000);
		expect(cleanCommentText(undefined)).toBe("");
		expect(cleanCommentText("é😀")).toBe("é😀");
	});
});

describe("anchoring", () => {
	it("keeps the line and its neighbours, and finds the line again after a move", () => {
		expect(excerptAround(FILE, 3)).toEqual({ excerpt: FILE.slice(1, 4), offset: 1 });
		expect(excerptAround(FILE, 1)).toEqual({ excerpt: FILE.slice(0, 2), offset: 0 });
		expect(excerptAround(FILE, 9)).toBeNull();
		expect(locateComment(["// header", "", ...FILE], comment())).toBe(5);
	});

	it("reads a comment whose lines are gone as gone, never a guessed line", () => {
		expect(locateComment(["class OrderService {}"], comment())).toBeNull();
	});
});

describe("copies of review-comments.json", () => {
	it("takes the union, the newest change winning", () => {
		const desktop = serializeComments([comment(), comment({ id: "c2", createdAt: "2026-11-06T11:00:00Z" })]);
		const worktree = serializeComments([comment({ status: "addressed", updatedAt: "2026-11-06T12:00:00Z" })]);
		const merged = parseCommentCopies([desktop, worktree, "{cut"]);
		expect(merged.map((c) => [c.id, c.status])).toEqual([
			["c1", "addressed"],
			["c2", "open"],
		]);
	});

	it("drops an entry whose path leaves the worktree", () => {
		const text = JSON.stringify({ comments: [{ id: "x", path: "../x", line: 1 }] });
		expect(parseCommentCopies([text])).toEqual([]);
	});
});

describe("the fixer's section of QA_FIX_REQUEST.md", () => {
	it("gives path:line, the excerpt and the ask", () => {
		const section = fixRequestSection([comment(), comment({ id: "c2", side: "old", line: 7, excerpt: [] })]);
		expect(section).toContain("## Review comments");
		expect(section).toContain("### src/OrderService.ts:3\n```\n  total(order) {");
		expect(section).toContain("> Handle a null order");
		expect(section).toContain("### src/OrderService.ts:7 (removed line)");
		expect(fixRequestSection([])).toBe("");
	});
});
