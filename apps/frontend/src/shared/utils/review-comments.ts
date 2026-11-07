/**
 * Review comments without the file system: parsing the copies of
 * `review-comments.json`, checking what the renderer sent, the excerpt that
 * anchors a comment, finding it again, and the section the fixer reads in
 * `QA_FIX_REQUEST.md`. The backend twin is `foundation/review_comments.py`.
 */
import type {
	ReviewComment,
	ReviewCommentInput,
	ReviewCommentStatus,
} from "../types/review-comments";

export const REVIEW_COMMENTS_FILE = "review-comments.json";
export const MAX_COMMENT_CHARS = 4000;
export const MAX_COMMENTS = 500;
const STATUSES: ReviewCommentStatus[] = ["open", "addressed", "resolved", "stale"];
const HEX = /^[0-9a-f]{7,64}$/;

/** A relative path inside the worktree, or null: no absolute path, no `..`. */
export function safeRelativePath(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	const p = raw.trim().replaceAll("\\", "/").replace(/^\.\//, "");
	if (!p || p.length > 1024 || p.startsWith("/") || /^[A-Za-z]:/.test(p)) return null;
	if (p.includes("\0") || p.split("/").some((s) => s === ".." || s === "")) return null;
	return p;
}

/** Control characters, and the invisible ones that reorder or hide text. */
function isHiddenChar(code: number): boolean {
	return (
		(code <= 0x1f && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
		code === 0x7f ||
		(code >= 0x200b && code <= 0x200f) ||
		(code >= 0x202a && code <= 0x202e) ||
		(code >= 0x2060 && code <= 0x2064) ||
		code === 0xfeff
	);
}

/** The person's text without control characters, bounded. */
export function cleanCommentText(raw: unknown): string {
	let out = "";
	for (const ch of String(raw ?? "")) {
		if (!isHiddenChar(ch.codePointAt(0) ?? 0)) out += ch;
	}
	return out.trim().slice(0, MAX_COMMENT_CHARS);
}

export type InputCheck =
	| { ok: true; input: ReviewCommentInput }
	| { ok: false; error: "invalid_path" | "invalid_line" | "empty_comment" | "invalid_commit" };

/** What the renderer sent, checked again in the main process (rule S6). */
export function checkCommentInput(raw: unknown): InputCheck {
	const r = (raw ?? {}) as Record<string, unknown>;
	const path = safeRelativePath(r.path);
	if (!path) return { ok: false, error: "invalid_path" };
	const line = Number(r.line);
	if (!Number.isInteger(line) || line < 1 || line > 10_000_000) return { ok: false, error: "invalid_line" };
	const text = cleanCommentText(r.text);
	if (!text) return { ok: false, error: "empty_comment" };
	const side = r.side === "old" ? "old" : "new";
	// The version the line numbers are in: a group's commit; none means the worktree
	// (new side) or HEAD (old side).
	if (r.commit !== undefined && r.commit !== null && (typeof r.commit !== "string" || !HEX.test(r.commit))) {
		return { ok: false, error: "invalid_commit" };
	}
	const commit = typeof r.commit === "string" ? r.commit : undefined;
	return { ok: true, input: { path, side, line, text, commit } };
}

/** The anchored line and one line on each side. */
export function excerptAround(lines: string[], line: number): { excerpt: string[]; offset: number } | null {
	if (line < 1 || line > lines.length) return null;
	const start = Math.max(0, line - 2);
	return { excerpt: lines.slice(start, line + 1), offset: line - 1 - start };
}

/** The comment's line in `lines`, by its excerpt, nearest its old line; null if gone. */
export function locateComment(lines: string[], comment: Pick<ReviewComment, "excerpt" | "excerptOffset" | "line">): number | null {
	const wanted = comment.excerpt.map((l) => l.trim());
	if (wanted.length === 0) return null;
	const expected = comment.line - comment.excerptOffset;
	let best: number | null = null;
	for (let i = 0; i + wanted.length <= lines.length; i++) {
		if (wanted.every((w, k) => lines[i + k].trim() === w)) {
			if (best === null || Math.abs(i + 1 - expected) < Math.abs(best + 1 - expected)) best = i;
		}
	}
	return best === null ? null : best + 1 + comment.excerptOffset;
}

/** One stored entry, snake_case as the backend reads it, or null if malformed. */
function fromStored(raw: unknown): ReviewComment | null {
	const c = raw as Record<string, unknown>;
	const path = safeRelativePath(c?.path);
	if (typeof c?.id !== "string" || !path || !Number.isInteger(c.line)) return null;
	const status = STATUSES.includes(c.status as ReviewCommentStatus) ? (c.status as ReviewCommentStatus) : "open";
	return {
		id: c.id,
		path,
		side: c.side === "old" ? "old" : "new",
		line: c.line as number,
		commit: typeof c.commit === "string" ? c.commit : "",
		excerpt: Array.isArray(c.excerpt) ? c.excerpt.map(String) : [],
		excerptOffset: Number.isInteger(c.excerpt_offset) ? (c.excerpt_offset as number) : 0,
		text: cleanCommentText(c.text),
		status,
		createdAt: String(c.created_at ?? ""),
		updatedAt: String(c.updated_at ?? c.created_at ?? ""),
		addressedSession: typeof c.addressed_session === "number" ? c.addressed_session : null,
	};
}

export function toStored(c: ReviewComment): Record<string, unknown> {
	return {
		id: c.id,
		path: c.path,
		side: c.side,
		line: c.line,
		commit: c.commit,
		excerpt: c.excerpt,
		excerpt_offset: c.excerptOffset,
		text: c.text,
		status: c.status,
		created_at: c.createdAt,
		updated_at: c.updatedAt,
		addressed_session: c.addressedSession ?? null,
	};
}

/** The union of the copies by id, the newest `updated_at` winning; oldest first. */
export function parseCommentCopies(texts: string[]): ReviewComment[] {
	const byId = new Map<string, ReviewComment>();
	for (const text of texts) {
		let data: unknown;
		try {
			data = JSON.parse(text);
		} catch {
			continue; // absent or cut: the other copy counts
		}
		const list = (data as { comments?: unknown })?.comments;
		if (!Array.isArray(list)) continue;
		for (const raw of list) {
			const c = fromStored(raw);
			if (!c) continue;
			const known = byId.get(c.id);
			if (!known || c.updatedAt > known.updatedAt) byId.set(c.id, c);
		}
	}
	return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function serializeComments(comments: ReviewComment[]): string {
	return `${JSON.stringify({ comments: comments.map(toStored) }, null, 2)}\n`;
}

/** The section of `QA_FIX_REQUEST.md` the fixer reads: `path:line`, excerpt, ask. */
export function fixRequestSection(comments: ReviewComment[]): string {
	if (comments.length === 0) return "";
	const blocks = comments.map((c) => {
		const where = `${c.path}:${c.line}${c.side === "old" ? " (removed line)" : ""}`;
		const fence = c.excerpt.some((l) => l.includes("```")) ? "~~~" : "```";
		const excerpt = c.excerpt.length ? `\n${fence}\n${c.excerpt.join("\n")}\n${fence}` : "";
		const ask = c.text.split("\n").map((l) => `> ${l}`).join("\n");
		return `### ${where}${excerpt}\n${ask}`;
	});
	return `\n\n## Review comments\n\nThe person commented these lines. Fix each one where it is anchored.\n\n${blocks.join("\n\n")}`;
}
