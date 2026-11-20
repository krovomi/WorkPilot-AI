/** @vitest-environment jsdom */
/**
 * The Groups tab, from creating a group to changing what it grants.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../../../shared/i18n";
import { useAdminStore } from "@/stores/admin-store";
import { usePermissionsStore } from "@/stores/permissions-store";
import { GroupsTab } from "../GroupsTab";

const ok = <T,>(data: T) => Promise.resolve({ ok: true as const, data });
const refused = (error: string) => Promise.resolve({ ok: false as const, error });

const FRONT = {
	id: "g-1",
	name: "Front team",
	description: "",
	role_slug: "reviewer",
	role_name: "Reviewer",
	members: [{ user_id: "u-1", email: "ana@example.test", display_name: "Ana" }],
	projects: [{ project_id: "p-1", name: "Shop", role: "member" }],
	created_at: "2026-10-31T00:00:00Z",
};
const EMPTY = {
	...FRONT,
	id: "g-2",
	name: "Empty team",
	role_slug: null,
	role_name: null,
	members: [],
	projects: [],
};

const bridge = {
	listGroups: vi.fn(),
	listRoles: vi.fn(),
	listMembers: vi.fn(),
	listGroupProjects: vi.fn(),
	createGroup: vi.fn(),
	updateGroup: vi.fn(),
	deleteGroup: vi.fn(),
	setGroupMember: vi.fn(),
	setGroupProjectRole: vi.fn(),
};

beforeEach(() => {
	for (const fn of Object.values(bridge)) fn.mockReset();
	bridge.listGroups.mockImplementation(() => ok([FRONT, EMPTY]));
	bridge.listRoles.mockImplementation(() =>
		ok([{ id: "r-1", slug: "reviewer", name: "Reviewer", scope: "org" }]),
	);
	bridge.listMembers.mockImplementation(() =>
		ok([
			{ user_id: "u-1", email: "ana@example.test", display_name: "Ana" },
			{ user_id: "u-2", email: "bo@example.test", display_name: "Bo" },
		]),
	);
	bridge.listGroupProjects.mockImplementation(() =>
		ok([
			{ id: "p-1", name: "Shop" },
			{ id: "p-2", name: "Billing" },
		]),
	);
	(globalThis as { electronAPI?: unknown }).electronAPI = { serverAdmin: bridge };
	useAdminStore.setState({ groups: [], roles: [], members: [], groupProjects: [], error: null });
	usePermissionsStore.setState({
		loaded: true,
		unrestricted: false,
		isPlatformAdmin: false,
		permissions: new Set(["org.member.read", "org.member.write", "project.member.write"]),
	});
});

afterEach(() => {
	cleanup();
	(globalThis as { electronAPI?: unknown }).electronAPI = undefined;
});

const groupButton = (name: string) =>
	screen.getByText(name, { selector: "button span" }).closest("button") as HTMLElement;

describe("GroupsTab flows", () => {
	it("says when there is no group yet", async () => {
		bridge.listGroups.mockImplementation(() => ok([]));
		render(<GroupsTab />);
		expect(await screen.findByText("No groups yet.")).toBeInTheDocument();
	});

	it("selects the first group, then another, and marks the one shown", async () => {
		render(<GroupsTab />);
		expect(await screen.findByRole("heading", { name: "Front team" })).toBeInTheDocument();
		expect(groupButton("Front team")).toHaveClass("bg-muted");
		expect(within(groupButton("Front team")).getByText("Reviewer")).toBeInTheDocument();
		expect(screen.getByText("1 members, 1 projects")).toBeInTheDocument();

		fireEvent.click(groupButton("Empty team"));
		expect(screen.getByRole("heading", { name: "Empty team" })).toBeInTheDocument();
		expect(groupButton("Front team")).not.toHaveClass("bg-muted");
		expect(screen.getByText("Nobody is in this group yet.")).toBeInTheDocument();
		expect(screen.getByText("This group has no project yet.")).toBeInTheDocument();
		expect(screen.getByLabelText("Organization role")).toHaveValue("");
	});

	it("shows a group's description", async () => {
		bridge.listGroups.mockImplementation(() => ok([{ ...FRONT, description: "Builds the UI" }]));
		render(<GroupsTab />);
		expect(await screen.findByText("Builds the UI")).toBeInTheDocument();
	});

	it("creates a group, and keeps the form when the server refuses", async () => {
		bridge.createGroup.mockImplementationOnce(() => refused("name taken"));
		bridge.createGroup.mockImplementationOnce(() => ok({ ...EMPTY, id: "g-3", name: "QA" }));
		render(<GroupsTab />);
		await screen.findByRole("heading", { name: "Front team" });
		fireEvent.click(screen.getByRole("button", { name: "New group" }));
		// The form replaces the group's details while it is open.
		expect(screen.queryByRole("heading", { name: "Front team" })).toBeNull();
		expect(groupButton("Front team")).not.toHaveClass("bg-muted");
		const save = screen.getByRole("button", { name: "Create group" });
		expect(save).toBeDisabled();
		fireEvent.change(screen.getByLabelText("Name"), { target: { value: " QA " } });
		fireEvent.change(screen.getByLabelText("Description"), { target: { value: " Tests " } });
		fireEvent.click(save);
		await waitFor(() =>
			expect(bridge.createGroup).toHaveBeenCalledWith({ name: "QA", description: "Tests" }),
		);
		expect(useAdminStore.getState().error).toBe("name taken");
		expect(screen.getByLabelText("Name")).toHaveValue(" QA ");

		fireEvent.click(save);
		await waitFor(() => expect(screen.queryByLabelText("Description")).toBeNull());
		expect(bridge.listGroups).toHaveBeenCalledTimes(2);

		fireEvent.click(screen.getByRole("button", { name: "New group" }));
		expect(screen.getByLabelText("Name")).toHaveValue("");
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(screen.getByRole("heading", { name: "Front team" })).toBeInTheDocument();
	});

	it("changes the organization role, removes a member and deletes the group", async () => {
		bridge.updateGroup.mockImplementation(() => ok({ ...FRONT, role_slug: null, role_name: null }));
		bridge.setGroupMember.mockImplementation(() => ok({ ...FRONT, members: [] }));
		bridge.deleteGroup.mockImplementation(() => ok(true));
		render(<GroupsTab />);
		const role = await screen.findByLabelText("Organization role");
		await waitFor(() => expect(role).toHaveValue("reviewer"));
		fireEvent.change(role, { target: { value: "" } });
		await waitFor(() => expect(bridge.updateGroup).toHaveBeenCalledWith("g-1", { role_slug: "" }));

		fireEvent.click(screen.getByTitle("Remove from the group"));
		await waitFor(() => expect(bridge.setGroupMember).toHaveBeenCalledWith("g-1", "u-1", false));
		expect(await screen.findByText("Nobody is in this group yet.")).toBeInTheDocument();

		fireEvent.click(screen.getByTitle("Delete this group"));
		await waitFor(() => expect(bridge.deleteGroup).toHaveBeenCalledWith("g-1"));
		expect(await screen.findByRole("heading", { name: "Empty team" })).toBeInTheDocument();
	});

	it("keeps the picked member when adding them is refused", async () => {
		bridge.setGroupMember.mockImplementation(() => refused("seat limit"));
		render(<GroupsTab />);
		const pick = await screen.findByLabelText("Add to the group");
		await waitFor(() => expect(pick).toHaveTextContent("Bo"));
		fireEvent.change(pick, { target: { value: "u-2" } });
		fireEvent.click(screen.getByRole("button", { name: "Add to the group" }));
		await waitFor(() => expect(useAdminStore.getState().error).toBe("seat limit"));
		expect(pick).toHaveValue("u-2");
	});

	it("changes a project's role, gives access with a chosen role, and keeps the pick when refused", async () => {
		bridge.setGroupProjectRole.mockImplementationOnce(() =>
			ok({ ...FRONT, projects: [{ project_id: "p-1", name: "Shop", role: "owner" }] }),
		);
		bridge.setGroupProjectRole.mockImplementationOnce(() => refused("not yours"));
		render(<GroupsTab />);
		const [current] = await screen.findAllByLabelText("Role on the project");
		expect(current).toHaveValue("member");
		fireEvent.change(current, { target: { value: "owner" } });
		await waitFor(() =>
			expect(bridge.setGroupProjectRole).toHaveBeenCalledWith("g-1", "p-1", "owner"),
		);
		await waitFor(() => expect(screen.getAllByLabelText("Role on the project")[0]).toHaveValue("owner"));

		const pick = screen.getByLabelText("Give access");
		await waitFor(() => expect(pick).toHaveTextContent("Billing"));
		fireEvent.change(pick, { target: { value: "p-2" } });
		fireEvent.change(screen.getAllByLabelText("Role on the project")[1], { target: { value: "viewer" } });
		fireEvent.click(screen.getByRole("button", { name: "Give access" }));
		await waitFor(() =>
			expect(bridge.setGroupProjectRole).toHaveBeenLastCalledWith("g-1", "p-2", "viewer"),
		);
		expect(pick).toHaveValue("p-2");
	});
});
