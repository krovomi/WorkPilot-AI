/**
 * Adding an account to an organization: the renderer's body reaches the
 * server only as the fields the route reads, an id or an email, and a role.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock("../../server-connection", () => ({
	adminApi: {},
	fetchMyPermissions: vi.fn(),
	getActiveOrgId: vi.fn(),
	setActiveOrg: vi.fn(),
	switchOrg: vi.fn(),
}));
vi.mock("../../server-admin-groups", () => ({ groupsApi: {} }));

import { memberToAdd } from "../server-admin-handlers";

describe("memberToAdd", () => {
	it("keeps an id or a trimmed email, and the role", () => {
		expect(memberToAdd({ user_id: "u1", role_slug: "viewer" })).toEqual({
			user_id: "u1",
			role_slug: "viewer",
		});
		expect(memberToAdd({ email: " cy@example.test ", role_slug: "lead", extra: 1 })).toEqual({
			email: "cy@example.test",
			role_slug: "lead",
		});
	});

	it("gives the default role when none is named", () => {
		expect(memberToAdd({ user_id: "u1" })).toEqual({ user_id: "u1", role_slug: "contributor" });
		expect(memberToAdd({ email: "cy@example.test", role_slug: "" })).toEqual({
			email: "cy@example.test",
			role_slug: "contributor",
		});
	});

	it.each([
		null,
		"u1",
		{},
		{ user_id: "u1", email: "cy@example.test" },
		{ user_id: "" },
		{ user_id: "x".repeat(65) },
		{ user_id: 42 },
		{ email: "not-an-address" },
		{ email: `${"a".repeat(320)}@example.test` },
		{ user_id: "u1", role_slug: "r".repeat(61) },
	])("refuses %j", (body) => {
		expect(memberToAdd(body)).toBeNull();
	});
});
