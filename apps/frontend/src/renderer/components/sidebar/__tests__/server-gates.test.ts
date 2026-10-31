import { describe, expect, it } from "vitest";
import type { Project } from "@shared/types";
import { SERVER_PROJECT_VIEWS, serverForge, showsView } from "../server-gates";

describe("server project views", () => {
	it("a server project shows only the views that work through the server", () => {
		expect(showsView("kanban", true)).toBe(true);
		expect(showsView("administration", true)).toBe(true);
		expect(showsView("roadmap", true)).toBe(true);
		expect(showsView("ideation", true)).toBe(true);
		expect(showsView("insights", true)).toBe(true);
		expect(showsView("context", true)).toBe(true);
		// Views that read or run things on this computer would act on the mirror.
		for (const view of ["terminals", "gitlab-issues", "github-prs"] as const) {
			expect(showsView(view, true)).toBe(false);
		}
		expect([...SERVER_PROJECT_VIEWS].sort()).toEqual([
			"administration",
			"context",
			"github-issues",
			"github-prs",
			"gitlab-issues",
			"gitlab-merge-requests",
			"ideation",
			"insights",
			"kanban",
			"roadmap",
		]);
	});

	it("a server project on GitHub shows its issues and pull requests", () => {
		const on = (repoUrl: string) =>
			serverForge({ remote: { repoUrl, defaultBranch: "main", role: "member" } } as Project);
		expect(on("https://github.com/acme/shop.git")).toBe("github");
		expect(on("git@github.com:acme/shop.git")).toBe("github");
		expect(on("https://gitlab.com/acme/shop.git")).toBeNull();
		expect(on("https://github.com.evil.test/acme/shop")).toBeNull();
		expect(serverForge(undefined)).toBeNull();
		expect(showsView("github-issues", true, "github")).toBe(true);
		expect(showsView("github-prs", true, "github")).toBe(true);
		expect(showsView("github-prs", true, null)).toBe(false);
		expect(showsView("terminals", true, "github")).toBe(false);
	});

	it("a server project on GitLab shows the views of the forge the server lists", () => {
		const listed = (forge: "github" | "gitlab" | null, repoUrl: string) =>
			serverForge({
				remote: { repoUrl, defaultBranch: "main", role: "member", forge },
			} as Project);
		expect(listed("gitlab", "https://git.acme.test/team/shop.git")).toBe("gitlab");
		// The server decides: a GitLab host its operator did not name is no forge.
		expect(listed(null, "https://gitlab.evil.test/team/shop.git")).toBeNull();
		expect(listed(null, "https://github.com/acme/shop.git")).toBeNull();
		expect(showsView("gitlab-issues", true, "gitlab")).toBe(true);
		expect(showsView("gitlab-merge-requests", true, "gitlab")).toBe(true);
		expect(showsView("github-issues", true, "gitlab")).toBe(false);
		expect(showsView("gitlab-issues", true, "github")).toBe(false);
		expect(showsView("gitlab-merge-requests", true, null)).toBe(false);
	});

	it("a project of this computer shows every view", () => {
		expect(showsView("terminals", false)).toBe(true);
		expect(showsView("kanban", false)).toBe(true);
	});
});
