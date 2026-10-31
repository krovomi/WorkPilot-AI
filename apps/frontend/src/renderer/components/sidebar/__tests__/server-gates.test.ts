import { describe, expect, it } from "vitest";
import { SERVER_PROJECT_VIEWS, showsView } from "../server-gates";

describe("server project views", () => {
	it("a server project shows only the views that work through the server", () => {
		expect(showsView("kanban", true)).toBe(true);
		expect(showsView("administration", true)).toBe(true);
		expect(showsView("roadmap", true)).toBe(true);
		// Views that read or run things on this computer would act on the mirror.
		for (const view of ["terminals", "insights", "github-prs", "context"] as const) {
			expect(showsView(view, true)).toBe(false);
		}
		expect([...SERVER_PROJECT_VIEWS].sort()).toEqual([
			"administration",
			"kanban",
			"roadmap",
		]);
	});

	it("a project of this computer shows every view", () => {
		expect(showsView("terminals", false)).toBe(true);
		expect(showsView("kanban", false)).toBe(true);
	});
});
