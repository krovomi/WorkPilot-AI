/** @vitest-environment jsdom */
/**
 * Syncing a worktree from another branch: the source branch is picked in the
 * app's Select, local and remote branches in their own groups.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../../../../shared/i18n";
import type { Task } from "../../../../../shared/types";
import { SyncFromBranchDialog } from "../SyncFromBranchDialog";

const api = {
	getGitBranches: vi.fn(),
	syncWorktreeFromBranch: vi.fn(),
};
const task = { id: "task-1", title: "One-page checkout" } as unknown as Task;

beforeEach(() => {
	api.getGitBranches.mockReset();
	api.syncWorktreeFromBranch.mockReset();
	(window as unknown as { electronAPI: typeof api }).electronAPI = api;
});
afterEach(cleanup);

function renderDialog() {
	render(
		<SyncFromBranchDialog open task={task} projectPath="/repos/demo" onOpenChange={vi.fn()} />,
	);
	return screen.getByRole("combobox", { name: "Source branch" });
}

async function open(user: ReturnType<typeof userEvent.setup>, trigger: HTMLElement) {
	await waitFor(() => expect(trigger).toBeEnabled());
	trigger.focus();
	await user.keyboard("[ArrowDown]");
}

describe("SyncFromBranchDialog", () => {
	it("says it is loading, then syncs from the remote branch picked", async () => {
		let answer: (value: unknown) => void = () => {};
		api.getGitBranches.mockReturnValue(new Promise((resolve) => (answer = resolve)));
		api.syncWorktreeFromBranch.mockResolvedValue({
			success: true,
			data: { success: true, message: "Merged" },
		});
		const trigger = renderDialog();
		expect(trigger).toHaveTextContent("Loading branches...");
		answer({ success: true, data: ["main", "origin/main"] });
		await waitFor(() => expect(trigger).toHaveTextContent("Select a branch..."));

		const user = userEvent.setup();
		await open(user, trigger);
		expect(screen.getByText("Local")).toBeInTheDocument();
		expect(screen.getByText("Remote")).toBeInTheDocument();
		await user.click(screen.getByRole("option", { name: "origin/main" }));
		expect(trigger).toHaveTextContent("origin/main");

		// The strategy cards also say "Merge", with their description: the sync
		// button is the one named by the strategy alone.
		await user.click(screen.getByRole("button", { name: "Merge" }));
		await waitFor(() =>
			expect(api.syncWorktreeFromBranch).toHaveBeenCalledWith("task-1", "origin/main", "merge"),
		);
	});

	it("shows only the group that has branches", async () => {
		api.getGitBranches.mockResolvedValue({ success: true, data: ["origin/release"] });
		const trigger = renderDialog();
		const user = userEvent.setup();
		await open(user, trigger);
		expect(await screen.findByRole("option", { name: "origin/release" })).toBeInTheDocument();
		expect(screen.queryByText("Local")).toBeNull();
	});

	it("lists local branches without a remote group", async () => {
		api.getGitBranches.mockResolvedValue({ success: true, data: ["feature/x"] });
		const trigger = renderDialog();
		const user = userEvent.setup();
		await open(user, trigger);
		expect(await screen.findByRole("option", { name: "feature/x" })).toBeInTheDocument();
		expect(screen.queryByText("Remote")).toBeNull();
	});
});
