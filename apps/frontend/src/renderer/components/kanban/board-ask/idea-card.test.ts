/**
 * The card « Vérifier une idée » creates holds only what is left to do: what
 * is missing, what is partly there with the tickets it builds on, what nobody
 * judged; what is done is listed apart, and the idea itself closes it.
 */
import { describe, expect, it } from "vitest";
import type { BoardIdeaResult } from "../../../../shared/types";
import { hasWorkLeft, ideaCard, type Translate } from "./idea-card";

const t: Translate = (key, options) => (options ? `${key} ${JSON.stringify(options)}` : key);

const result: BoardIdeaResult = {
	title: "Admin user export",
	summary: "The export exists; the email is missing.",
	requirements: [
		{ text: "Export users to CSV", verdict: "done", matches: [{ taskId: "a", title: "Export CSV", state: "done" }] },
		{ text: "Filter by role", verdict: "done", matches: [] },
		{
			text: "Email when ready",
			verdict: "partial",
			reason: "Only in-app notices",
			matches: [{ taskId: "b", title: "Notifications", state: "done" }],
		},
		{ text: "Audit log", verdict: "partial", matches: [] },
		{ text: "Schedule exports", verdict: "missing", matches: [] },
		{ text: "Zip large files", verdict: "unknown", matches: [{ taskId: "c", title: "Archives", state: "planned" }] },
	],
	mode: "ai",
	searched: 9,
};

describe("ideaCard", () => {
	it("lists what is left first, what is done apart, and the idea at the end", () => {
		const card = ideaCard(result, "  Admins export users\n", t);
		expect(card.title).toBe("Admin user export");
		expect(card.description).toBe(
			[
				"The export exists; the email is missing.",
				"",
				"## kanban.ask.idea.card.section.missing",
				"",
				"- Schedule exports",
				"",
				"## kanban.ask.idea.card.section.partial",
				"",
				"- Email when ready (Only in-app notices)",
				'  - kanban.ask.idea.card.buildsOn {"tickets":"Notifications"}',
				"- Audit log",
				"",
				"## kanban.ask.idea.card.section.unknown",
				"",
				"- Zip large files",
				"",
				"## kanban.ask.idea.card.section.done",
				"",
				"- Export users to CSV → Export CSV",
				"- Filter by role",
				"",
				"## kanban.ask.idea.card.original",
				"",
				"Admins export users",
			].join("\n"),
		);
	});

	it("titles the card with the idea's first line, or a generic title", () => {
		const bare = { ...result, title: "", summary: "", requirements: [] };
		expect(ideaCard(bare, "Export\nmore", t)).toEqual({
			title: "Export",
			description: "## kanban.ask.idea.card.original\n\nExport\nmore",
		});
		expect(ideaCard(bare, "", t).title).toBe("kanban.ask.idea.card.untitled");
		expect(ideaCard({ ...bare, title: "x".repeat(200) }, "", t).title).toHaveLength(120);
	});
});

describe("hasWorkLeft", () => {
	it("is true while a requirement is not done", () => {
		expect(hasWorkLeft(result)).toBe(true);
		expect(hasWorkLeft({ ...result, requirements: result.requirements.slice(0, 2) })).toBe(false);
	});
});
