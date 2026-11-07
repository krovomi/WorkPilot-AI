/**
 * Server mode: group administration. The renderer is not trusted, so every
 * argument is checked before it reaches a URL or a body, and a bad one never
 * becomes a request.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const connection = vi.hoisted(() => ({ authedFetch: vi.fn() }));

vi.mock("../server-connection", () => ({ authedFetch: connection.authedFetch }));

import { groupsApi } from "../server-admin-groups";

const GROUP = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";
const USER = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const PROJECT = "6f1c2b9e-0d4a-4c1e-9a7b-1f2e3d4c5b6a";

beforeEach(() => {
	connection.authedFetch.mockReset();
	connection.authedFetch.mockResolvedValue({ ok: true, data: { id: GROUP } });
});

describe("groupsApi", () => {
	it("creates a group with a trimmed name and leaves out an empty role", async () => {
		await groupsApi.create({ name: "  Front  ", description: "UI", role_slug: "" });
		expect(connection.authedFetch).toHaveBeenCalledWith("/admin/groups", "POST", {
			name: "Front",
			description: "UI",
		});
	});

	it("keeps an empty role on update, which removes the group's role", async () => {
		await groupsApi.update(GROUP, { role_slug: "" });
		expect(connection.authedFetch).toHaveBeenCalledWith(
			`/admin/groups/${GROUP}`,
			"PATCH",
			{ role_slug: "" },
		);
	});

	it("adds and removes a member with PUT and DELETE", async () => {
		await groupsApi.setMember(GROUP, USER, true);
		await groupsApi.setMember(GROUP, USER, false);
		expect(connection.authedFetch.mock.calls).toEqual([
			[`/admin/groups/${GROUP}/members/${USER}`, "PUT"],
			[`/admin/groups/${GROUP}/members/${USER}`, "DELETE"],
		]);
	});

	it("gives a project role, and takes the project away on a null role", async () => {
		await groupsApi.setProjectRole(GROUP, PROJECT, "viewer");
		await groupsApi.setProjectRole(GROUP, PROJECT, null);
		expect(connection.authedFetch.mock.calls).toEqual([
			[`/admin/groups/${GROUP}/projects/${PROJECT}`, "PUT", { role: "viewer" }],
			[`/admin/groups/${GROUP}/projects/${PROJECT}`, "DELETE"],
		]);
	});

	it("refuses hostile arguments without sending anything", async () => {
		const answers = await Promise.all([
			groupsApi.update("../users", { name: "x" }),
			groupsApi.remove("a/b"),
			groupsApi.setMember(GROUP, "../../orgs", true),
			groupsApi.setMember(GROUP, USER, "yes"),
			groupsApi.setProjectRole(GROUP, PROJECT, "admin"),
			groupsApi.setProjectRole(GROUP, "x?project_id=1", "viewer"),
			groupsApi.create({ name: "   " }),
			groupsApi.create({ name: "x".repeat(121) }),
			groupsApi.create({ name: "Front", role_slug: "Admin Role" }),
			groupsApi.update(GROUP, { description: 42 }),
		]);
		for (const answer of answers) expect(answer.ok).toBe(false);
		expect(connection.authedFetch).not.toHaveBeenCalled();
	});

	it("lists projects as id and name only, skipping malformed entries", async () => {
		connection.authedFetch.mockResolvedValue({
			ok: true,
			data: [
				{ id: PROJECT, name: "App", repo_url: "https://git.example/app" },
				{ id: "../etc", name: "Bad" },
				{ id: GROUP },
				"nope",
			],
		});
		const result = await groupsApi.projects();
		expect(connection.authedFetch).toHaveBeenCalledWith("/projects", "GET");
		expect(result).toEqual({ ok: true, data: [{ id: PROJECT, name: "App" }] });
	});
});
