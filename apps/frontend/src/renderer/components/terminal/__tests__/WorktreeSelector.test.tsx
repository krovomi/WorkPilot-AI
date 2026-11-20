/**
 * Moving a terminal into a worktree: the selector lists the terminal, task and
 * other worktrees of the project, filters and walks them from the keyboard,
 * says when they could not be listed, and deletes a terminal worktree after a
 * confirmation that says whether its branch goes too.
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	OtherWorktreeInfo,
	Project,
	TerminalWorktreeConfig,
	WorktreeListItem,
} from "../../../../shared/types";
import { useProjectStore } from "../../../stores/project-store";
import { WorktreeSelector } from "../WorktreeSelector";

const PROJECT = "/work/shop";
const initialProjects = useProjectStore.getState();

const CART: TerminalWorktreeConfig = {
	name: "cart",
	worktreePath: "/work/shop/.worktrees/cart",
	branchName: "terminal/cart",
	baseBranch: "main",
	hasGitBranch: true,
	createdAt: "2026-11-01T10:00:00.000Z",
	terminalId: "term-0",
};
const SCRATCH: TerminalWorktreeConfig = {
	...CART,
	name: "scratch",
	worktreePath: "/work/shop/.worktrees/scratch",
	branchName: "",
	hasGitBranch: false,
};
const REFUNDS = {
	specName: "012-refunds",
	path: "/work/shop/.workpilot/worktrees/012-refunds",
	branch: "workpilot/012-refunds",
	baseBranch: "develop",
} as WorktreeListItem;
const HOTFIX: OtherWorktreeInfo = { path: "/work/hotfix", branch: "hotfix/pay", commitSha: "1a2b3c4d", displayName: "hotfix" };
const BISECT: OtherWorktreeInfo = { path: "/work/bisect", branch: null, commitSha: "9f8e7d6c", displayName: "bisect" };

const api = {
	listTerminalWorktrees: vi.fn(),
	listWorktrees: vi.fn(),
	listOtherWorktrees: vi.fn(),
	removeTerminalWorktree: vi.fn(),
};

const onCreateWorktree = vi.fn();
const onSelectWorktree = vi.fn();

function selector() {
	return render(
		<WorktreeSelector
			terminalId="term-1"
			projectPath={PROJECT}
			onCreateWorktree={onCreateWorktree}
			onSelectWorktree={onSelectWorktree}
		/>,
	);
}

async function openSelector(user: ReturnType<typeof userEvent.setup>) {
	await user.click(screen.getByRole("button", { name: /Worktree/ }));
	return screen.findByRole("combobox");
}

const optionNames = () => screen.getAllByRole("option").map((o) => o.querySelector(".font-medium")?.textContent);

beforeEach(async () => {
	vi.resetAllMocks();
	await i18n.changeLanguage("en");
	useProjectStore.setState({ projects: [{ id: "p1", path: PROJECT } as unknown as Project] });
	api.listTerminalWorktrees.mockResolvedValue({ success: true, data: [CART, SCRATCH] });
	api.listWorktrees.mockResolvedValue({ success: true, data: { worktrees: [REFUNDS] } });
	api.listOtherWorktrees.mockResolvedValue({ success: true, data: [HOTFIX, BISECT] });
	api.removeTerminalWorktree.mockResolvedValue({ success: true });
	Object.assign(globalThis.electronAPI, api);
});

afterEach(() => {
	useProjectStore.setState(initialProjects, true);
});

describe("WorktreeSelector listing", () => {
	it("lists every kind of worktree under its heading, with its branch or detached commit", async () => {
		const user = userEvent.setup();
		selector();
		const search = await openSelector(user);
		expect(document.activeElement).toBe(search);
		await waitFor(() => expect(optionNames()).toEqual(["cart", "scratch", "012-refunds", "hotfix", "bisect"]));
		expect(api.listTerminalWorktrees).toHaveBeenCalledWith(PROJECT);
		expect(api.listWorktrees).toHaveBeenCalledWith("p1", { includeStats: false });
		expect(api.listOtherWorktrees).toHaveBeenCalledWith(PROJECT);
		for (const heading of ["Terminal Worktrees", "Task Worktrees", "Others"]) {
			expect(screen.getByText(heading)).toBeTruthy();
		}
		expect(screen.getByText("terminal/cart")).toBeTruthy();
		expect(screen.getByText("9f8e7d6c (detached)")).toBeTruthy();
		const scratch = screen.getAllByRole("option")[1];
		expect(scratch.querySelectorAll("span")).toHaveLength(1);
		expect(within(screen.getAllByRole("option")[2]).queryByRole("button")).toBeNull();
	});

	it("separates the headings only between groups that are shown", async () => {
		api.listTerminalWorktrees.mockResolvedValue({ success: true, data: [] });
		api.listWorktrees.mockResolvedValue({ success: true, data: { worktrees: [] } });
		const user = userEvent.setup();
		selector();
		await openSelector(user);
		await waitFor(() => expect(optionNames()).toEqual(["hotfix", "bisect"]));
		expect(screen.queryByText("Terminal Worktrees")).toBeNull();
		expect(screen.queryByText("Task Worktrees")).toBeNull();
		expect(screen.getByRole("listbox").querySelector(".my-1")).toBeNull();
	});

	it("skips task worktrees for a project it does not know", async () => {
		useProjectStore.setState({ projects: [] });
		api.listOtherWorktrees.mockResolvedValue({ success: true, data: [] });
		const user = userEvent.setup();
		selector();
		await openSelector(user);
		await waitFor(() => expect(optionNames()).toEqual(["cart", "scratch"]));
		expect(api.listWorktrees).not.toHaveBeenCalled();
		expect(screen.queryByText("Others")).toBeNull();
	});

	it("says there is nothing to move to", async () => {
		api.listTerminalWorktrees.mockResolvedValue({ success: true, data: [] });
		api.listWorktrees.mockResolvedValue({ success: true, data: { worktrees: [] } });
		api.listOtherWorktrees.mockResolvedValue({ success: true, data: [] });
		const user = userEvent.setup();
		selector();
		await openSelector(user);
		expect(await screen.findByText("No worktrees found")).toBeTruthy();
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("says when no list could be read, and shows what could", async () => {
		const user = userEvent.setup();
		api.listTerminalWorktrees.mockResolvedValue({ success: false, error: "not a git repository" });
		api.listWorktrees.mockResolvedValue({ success: false });
		api.listOtherWorktrees.mockResolvedValue({ success: false });
		selector();
		await openSelector(user);
		expect((await screen.findByRole("alert")).textContent).toBe("Could not list the worktrees.");
		await user.keyboard("{Escape}");

		api.listTerminalWorktrees.mockResolvedValue({ success: true, data: [CART] });
		await openSelector(user);
		await waitFor(() => expect(optionNames()).toEqual(["cart"]));
		expect(screen.queryByRole("alert")).toBeNull();
		await user.keyboard("{Escape}");

		// A failing task listing alone is a failure too.
		api.listTerminalWorktrees.mockResolvedValue({ success: true, data: [] });
		api.listOtherWorktrees.mockResolvedValue({ success: true, data: [] });
		await openSelector(user);
		expect((await screen.findByRole("alert")).textContent).toBe("Could not list the worktrees.");
	});

	it("says when listing threw", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		api.listOtherWorktrees.mockRejectedValue(new Error("ipc closed"));
		const user = userEvent.setup();
		selector();
		await openSelector(user);
		expect((await screen.findByRole("alert")).textContent).toBe("Could not list the worktrees.");
		expect(error).toHaveBeenCalledWith("Failed to fetch worktrees:", expect.any(Error));
		error.mockRestore();
	});

	it("filters by name or branch, ignoring case and spaces", async () => {
		const user = userEvent.setup();
		selector();
		const search = await openSelector(user);
		await waitFor(() => expect(optionNames()).toHaveLength(5));
		await user.type(search, "  PAY ");
		expect(optionNames()).toEqual(["hotfix"]);
		await user.clear(search);
		await user.type(search, "refunds");
		expect(optionNames()).toEqual(["012-refunds"]);
		await user.clear(search);
		await user.type(search, "nothing");
		expect(screen.getByText("No worktrees found")).toBeTruthy();
	});

	it("starts the next opening with an empty search", async () => {
		const user = userEvent.setup();
		selector();
		const search = await openSelector(user);
		await user.type(search, "cart");
		await user.keyboard("{Escape}");
		expect(screen.queryByRole("combobox")).toBeNull();
		expect(((await openSelector(user)) as HTMLInputElement).value).toBe("");
	});
});

describe("WorktreeSelector choosing", () => {
	it("walks the list from the keyboard and moves the terminal into the focused worktree", async () => {
		const user = userEvent.setup();
		selector();
		const search = await openSelector(user);
		await waitFor(() => expect(optionNames()).toHaveLength(5));
		const options = () => screen.getAllByRole("option");
		const focused = () => options().findIndex((o) => o.getAttribute("aria-selected") === "true");

		expect(search.getAttribute("aria-activedescendant")).toBe(options()[0].id);
		await user.keyboard("{ArrowUp}");
		expect(focused()).toBe(4);
		await user.keyboard("{ArrowDown}");
		expect(focused()).toBe(0);
		await user.keyboard("{End}");
		expect(focused()).toBe(4);
		await user.keyboard("{ArrowUp}");
		expect(focused()).toBe(3);
		await user.keyboard("{Home}");
		await user.keyboard("{ArrowDown}");
		expect(focused()).toBe(1);
		expect(search.getAttribute("aria-activedescendant")).toBe(options()[1].id);
		fireEvent.mouseEnter(options()[2]);
		expect(focused()).toBe(2);
		await user.keyboard("{Enter}");

		expect(onSelectWorktree).toHaveBeenCalledWith({
			name: "012-refunds",
			worktreePath: REFUNDS.path,
			branchName: "workpilot/012-refunds",
			baseBranch: "develop",
			hasGitBranch: true,
			createdAt: expect.any(String),
			terminalId: "term-1",
		});
		expect(screen.queryByRole("combobox")).toBeNull();
	});

	it("does nothing on Enter or arrows when nothing is listed", async () => {
		api.listTerminalWorktrees.mockResolvedValue({ success: true, data: [] });
		api.listWorktrees.mockResolvedValue({ success: true, data: { worktrees: [] } });
		api.listOtherWorktrees.mockResolvedValue({ success: true, data: [] });
		const user = userEvent.setup();
		selector();
		const search = await openSelector(user);
		await screen.findByText("No worktrees found");
		expect(search.getAttribute("aria-activedescendant")).toBeNull();
		await user.keyboard("{ArrowDown}{ArrowUp}{End}{Enter}");
		expect(onSelectWorktree).not.toHaveBeenCalled();
		expect(screen.getByRole("combobox")).toBeTruthy();
	});

	it("moves into a terminal worktree as it is, and into another one with or without a branch", async () => {
		const user = userEvent.setup();
		selector();
		await openSelector(user);
		await waitFor(() => expect(optionNames()).toHaveLength(5));
		await user.click(screen.getAllByRole("option")[0]);
		expect(onSelectWorktree).toHaveBeenLastCalledWith(CART);

		await openSelector(user);
		await waitFor(() => expect(optionNames()).toHaveLength(5));
		fireEvent.keyDown(screen.getAllByRole("option")[3], { key: "Enter" });
		expect(onSelectWorktree).toHaveBeenLastCalledWith(
			expect.objectContaining({ name: "hotfix", branchName: "hotfix/pay", baseBranch: "", hasGitBranch: true }),
		);

		await openSelector(user);
		await waitFor(() => expect(optionNames()).toHaveLength(5));
		fireEvent.keyDown(screen.getAllByRole("option")[4], { key: "a" });
		expect(onSelectWorktree).toHaveBeenCalledTimes(2);
		await user.click(screen.getAllByRole("option")[4]);
		expect(onSelectWorktree).toHaveBeenLastCalledWith(
			expect.objectContaining({ name: "bisect", worktreePath: "/work/bisect", branchName: "", hasGitBranch: false }),
		);
	});

	it("asks for a new worktree", async () => {
		const user = userEvent.setup();
		selector();
		await openSelector(user);
		await user.click(screen.getByRole("button", { name: "New Worktree" }));
		expect(onCreateWorktree).toHaveBeenCalledTimes(1);
		expect(screen.queryByRole("combobox")).toBeNull();
	});
});

describe("WorktreeSelector delete", () => {
	async function askToDelete(user: ReturnType<typeof userEvent.setup>, index: number) {
		await openSelector(user);
		await waitFor(() => expect(optionNames()).toHaveLength(5));
		await user.click(within(screen.getAllByRole("option")[index]).getByRole("button", { name: "Delete" }));
		return screen.findByRole("alertdialog");
	}

	it("says the branch goes too, deletes, and lists again", async () => {
		const user = userEvent.setup();
		selector();
		const dialog = await askToDelete(user, 0);
		expect(onSelectWorktree).not.toHaveBeenCalled();
		expect(dialog.textContent).toContain("This will permanently delete the worktree and its branch.");
		expect(dialog.textContent).toContain("cart (terminal/cart)");
		api.listTerminalWorktrees.mockResolvedValue({ success: true, data: [SCRATCH] });
		await user.click(within(dialog).getByRole("button", { name: "Delete" }));

		expect(api.removeTerminalWorktree).toHaveBeenCalledWith(PROJECT, "cart", true);
		await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
		await openSelector(user);
		await waitFor(() => expect(optionNames()).toEqual(["scratch", "012-refunds", "hotfix", "bisect"]));
	});

	it("stays open, locked, while the deletion runs", async () => {
		let answer!: (value: { success: boolean }) => void;
		api.removeTerminalWorktree.mockReturnValue(
			new Promise((resolve) => {
				answer = resolve;
			}),
		);
		const user = userEvent.setup();
		selector();
		const dialog = await askToDelete(user, 0);
		await user.click(within(dialog).getByRole("button", { name: "Delete" }));

		expect(within(dialog).getByRole("button", { name: "Deleting..." })).toHaveProperty("disabled", true);
		expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveProperty("disabled", true);
		await user.keyboard("{Escape}");
		expect(screen.getByRole("alertdialog")).toBe(dialog);
		await act(async () => answer({ success: true }));
		await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
	});

	it("keeps the branch of a worktree that did not create one", async () => {
		const user = userEvent.setup();
		selector();
		const dialog = await askToDelete(user, 1);
		expect(dialog.textContent).toContain("This will permanently delete the worktree. Any uncommitted");
		expect(dialog.textContent).not.toContain("(");
		await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
		expect(api.removeTerminalWorktree).not.toHaveBeenCalled();
	});

	it("says which worktree could not be deleted, until the list is closed", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		api.removeTerminalWorktree.mockResolvedValueOnce({ success: false, error: "locked" }).mockRejectedValueOnce(new Error("gone"));
		const user = userEvent.setup();
		selector();
		let dialog = await askToDelete(user, 0);
		await user.click(within(dialog).getByRole("button", { name: "Delete" }));
		await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
		await openSelector(user);
		expect((await screen.findByRole("alert")).textContent).toBe("Could not delete the worktree cart.");
		await user.keyboard("{Escape}");

		dialog = await askToDelete(user, 1);
		expect(screen.queryByText(/Could not delete/)).toBeNull();
		await user.click(within(dialog).getByRole("button", { name: "Delete" }));
		await waitFor(() => expect(error).toHaveBeenCalledWith("Failed to delete worktree:", expect.any(Error)));
		await openSelector(user);
		expect((await screen.findByRole("alert")).textContent).toBe("Could not delete the worktree scratch.");
		error.mockRestore();
	});
});

