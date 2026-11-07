/** @vitest-environment jsdom */
/**
 * The Groups tab: a group shows its people and projects, and offers only the
 * changes the signed-in user's permissions allow.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../../shared/i18n";
import { useAdminStore } from "@/stores/admin-store";
import { usePermissionsStore } from "@/stores/permissions-store";
import { GroupsTab } from "./GroupsTab";

const GROUP = {
	id: "g-1",
	name: "Front team",
	description: "The people who build the UI",
	role_slug: null,
	role_name: null,
	members: [{ user_id: "u-1", email: "ana@example.test", display_name: "Ana" }],
	projects: [{ project_id: "p-1", name: "Shop", role: "member" }],
	created_at: "2026-10-31T00:00:00Z",
};

const bridge = {
	listGroups: vi.fn(),
	listRoles: vi.fn(),
	listMembers: vi.fn(),
	listGroupProjects: vi.fn(),
	setGroupMember: vi.fn(),
	setGroupProjectRole: vi.fn(),
	updateGroup: vi.fn(),
};

function grant(...permissions: string[]): void {
	usePermissionsStore.setState({
		loaded: true,
		unrestricted: false,
		isPlatformAdmin: false,
		permissions: new Set(permissions),
	});
}

beforeEach(() => {
	for (const fn of Object.values(bridge)) fn.mockReset();
	bridge.listGroups.mockResolvedValue({ ok: true, data: [GROUP] });
	bridge.listRoles.mockResolvedValue({
		ok: true,
		data: [
			{ id: "r-1", slug: "reviewer", name: "Reviewer", scope: "org" },
			{ id: "r-2", slug: "proj-only", name: "Project only", scope: "project" },
		],
	});
	bridge.listMembers.mockResolvedValue({
		ok: true,
		data: [
			{ user_id: "u-1", email: "ana@example.test", display_name: "Ana" },
			{ user_id: "u-2", email: "bo@example.test", display_name: "Bo" },
		],
	});
	bridge.listGroupProjects.mockResolvedValue({
		ok: true,
		data: [
			{ id: "p-1", name: "Shop" },
			{ id: "p-2", name: "Billing" },
		],
	});
	(globalThis as { electronAPI?: unknown }).electronAPI = { serverAdmin: bridge };
	useAdminStore.setState({ groups: [], roles: [], members: [], groupProjects: [] });
});

afterEach(() => {
	cleanup();
	(globalThis as { electronAPI?: unknown }).electronAPI = undefined;
});

describe("GroupsTab", () => {
	it("shows a group's members and projects read-only without write rights", async () => {
		grant("org.member.read");
		render(<GroupsTab />);

		expect(await screen.findByText("ana@example.test")).toBeInTheDocument();
		expect(screen.getAllByText("Shop").length).toBeGreaterThan(0);
		expect(screen.queryByRole("button", { name: /new group/i })).not.toBeInTheDocument();
		expect(screen.queryByTitle("Remove from the group")).not.toBeInTheDocument();
		expect(screen.getByLabelText("Organization role")).toBeDisabled();
	});

	it("offers only organization roles, and adds a member who is not in yet", async () => {
		grant("org.member.read", "org.member.write");
		bridge.setGroupMember.mockResolvedValue({
			ok: true,
			data: {
				...GROUP,
				members: [
					...GROUP.members,
					{ user_id: "u-2", email: "bo@example.test", display_name: "Bo" },
				],
			},
		});
		render(<GroupsTab />);

		const roleSelect = await screen.findByLabelText("Organization role");
		await waitFor(() => expect(roleSelect).toHaveTextContent("Reviewer"));
		expect(roleSelect).not.toHaveTextContent("Project only");

		const pick = screen.getByLabelText("Add to the group");
		expect(pick).not.toHaveTextContent("Ana");
		fireEvent.change(pick, { target: { value: "u-2" } });
		fireEvent.click(screen.getByRole("button", { name: "Add to the group" }));

		await waitFor(() =>
			expect(bridge.setGroupMember).toHaveBeenCalledWith("g-1", "u-2", true),
		);
		expect(await screen.findByText("bo@example.test")).toBeInTheDocument();
	});

	it("gives the group a project role only with project.member.write", async () => {
		grant("org.member.read", "project.member.write");
		bridge.setGroupProjectRole.mockResolvedValue({ ok: true, data: GROUP });
		render(<GroupsTab />);

		const pick = await screen.findByLabelText("Give access");
		await waitFor(() => expect(pick).toHaveTextContent("Billing"));
		fireEvent.change(pick, { target: { value: "p-2" } });
		fireEvent.click(screen.getByRole("button", { name: "Give access" }));
		await waitFor(() =>
			expect(bridge.setGroupProjectRole).toHaveBeenCalledWith("g-1", "p-2", "member"),
		);

		fireEvent.click(screen.getByTitle("Take this project away from the group"));
		await waitFor(() =>
			expect(bridge.setGroupProjectRole).toHaveBeenCalledWith("g-1", "p-1", null),
		);
	});
});
