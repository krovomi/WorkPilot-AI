/**
 * Creating a terminal worktree: the name is cleaned as it is typed and before
 * it is sent, a task can name it, the base branch can be local or remote, a
 * failure is shown in the dialog, and closing it (Cancel included) starts the
 * next one from an empty form. A branch list that arrives after the dialog was
 * closed is dropped.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "i18next";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitBranchDetail, Project, Task, TerminalWorktreeConfig } from "../../../../shared/types";
import { useProjectStore } from "../../../stores/project-store";
import { CreateWorktreeDialog } from "../CreateWorktreeDialog";

const toast = vi.hoisted(() => vi.fn());
vi.mock("../../../hooks/use-toast", () => ({ useToast: () => ({ toast }) }));

const PROJECT = "/work/shop";
const initialProjects = useProjectStore.getState();

const BRANCHES: GitBranchDetail[] = [
	{ name: "feature/cart", displayName: "feature/cart", type: "local" } as GitBranchDetail,
	{ name: "origin/release", displayName: "origin/release", type: "remote" } as GitBranchDetail,
];

const CONFIG = { name: "my-feature", worktreePath: "/work/shop/.worktrees/my-feature" } as TerminalWorktreeConfig;

function task(id: string, title: string): Task {
	return { id, title, description: "", status: "backlog" } as Task;
}

const api = {
	getGitBranchesWithInfo: vi.fn(),
	detectMainBranch: vi.fn(),
	createTerminalWorktree: vi.fn(),
};

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

const onWorktreeCreated = vi.fn();
const onOpenChange = vi.fn();

/** The terminal owns the open state; the dialog asks it to close. */
function Host({ tasks = [], initiallyOpen = true }: { tasks?: Task[]; initiallyOpen?: boolean }) {
	const [open, setOpen] = useState(initiallyOpen);
	return (
		<>
			<button type="button" onClick={() => setOpen(true)}>
				reopen
			</button>
			<CreateWorktreeDialog
				open={open}
				onOpenChange={(next) => {
					onOpenChange(next);
					setOpen(next);
				}}
				terminalId="term-1"
				projectPath={PROJECT}
				backlogTasks={tasks}
				onWorktreeCreated={onWorktreeCreated}
			/>
		</>
	);
}

const nameField = () => screen.getByLabelText("Worktree Name") as HTMLInputElement;
const createButton = () => screen.getByRole("button", { name: "Create" });

async function pickBaseBranch(user: ReturnType<typeof userEvent.setup>, label: string) {
	await user.click(screen.getByRole("combobox", { name: /Base Branch/ }));
	await user.click(await screen.findByRole("option", { name: new RegExp(label) }));
}

async function pickTask(user: ReturnType<typeof userEvent.setup>, name: string) {
	act(() => screen.getByRole("combobox", { name: /Link to Task/ }).focus());
	await user.keyboard("[ArrowDown]");
	fireEvent.keyDown(await screen.findByRole("option", { name }), { key: "Enter" });
	await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
}

beforeEach(async () => {
	vi.resetAllMocks();
	await i18n.changeLanguage("en");
	api.getGitBranchesWithInfo.mockResolvedValue({ success: true, data: BRANCHES });
	api.detectMainBranch.mockResolvedValue({ success: true, data: "develop" });
	api.createTerminalWorktree.mockResolvedValue({ success: true, config: CONFIG });
	Object.assign(globalThis.electronAPI, api);
});

afterEach(() => {
	useProjectStore.setState(initialProjects, true);
});

describe("CreateWorktreeDialog", () => {
	it("creates a worktree from a cleaned name on a local base branch, without a git branch", async () => {
		const user = userEvent.setup();
		render(<Host />);
		await waitFor(() => expect(screen.getByText("Use project default (develop)")).toBeTruthy());
		expect(api.getGitBranchesWithInfo).toHaveBeenCalledWith(PROJECT);
		expect(createButton()).toHaveProperty("disabled", true);
		expect(screen.getByText("Creates branch: terminal/my-feature")).toBeTruthy();

		fireEvent.change(nameField(), { target: { value: "Cart  Checkout!__" } });
		expect(nameField().value).toBe("cart-checkout!__");
		expect(screen.getByText("Creates branch: terminal/cart-checkout")).toBeTruthy();

		await pickBaseBranch(user, "feature/cart");
		await user.click(screen.getByRole("switch"));
		await user.click(createButton());

		expect(api.createTerminalWorktree).toHaveBeenCalledWith({
			terminalId: "term-1",
			name: "cart-checkout",
			taskId: undefined,
			createGitBranch: false,
			projectPath: PROJECT,
			baseBranch: "feature/cart",
			useLocalBranch: true,
		});
		expect(onWorktreeCreated).toHaveBeenCalledWith(CONFIG);
		expect(onOpenChange).toHaveBeenCalledWith(false);
		expect(toast).not.toHaveBeenCalled();
	});

	it("uses the project's own main branch, sends a remote base as such, and warns when tracking failed", async () => {
		useProjectStore.setState({
			projects: [{ id: "p1", path: PROJECT, settings: { mainBranch: "trunk" } } as unknown as Project],
		});
		api.createTerminalWorktree.mockResolvedValue({ success: true, config: CONFIG, warning: "fatal: no remote" });
		const user = userEvent.setup();
		render(<Host />);
		await waitFor(() => expect(screen.getByText("Use project default (trunk)")).toBeTruthy());
		expect(api.detectMainBranch).not.toHaveBeenCalled();

		fireEvent.change(nameField(), { target: { value: "release-fix" } });
		await pickBaseBranch(user, "origin/release");
		await user.click(createButton());

		expect(api.createTerminalWorktree).toHaveBeenCalledWith(
			expect.objectContaining({ baseBranch: "origin/release", useLocalBranch: false, createGitBranch: true }),
		);
		expect(toast).toHaveBeenCalledWith({
			title: "Remote Tracking Not Set Up",
			description:
				"Worktree created but the branch could not be pushed to remote. You may need to run git push -u manually.",
			variant: "destructive",
		});
	});

	it("names the worktree after the first task picked, and can drop the task again", async () => {
		const user = userEvent.setup();
		const long = "Let a customer pay with a saved card, or a voucher";
		render(<Host tasks={[task("t1", long), task("t2", "Refunds")]} />);
		await waitFor(() => expect(api.detectMainBranch).toHaveBeenCalled());

		await pickTask(user, long);
		expect(nameField().value).toBe("let-a-customer-pay-with-a-saved-card-or");

		await pickTask(user, "Refunds");
		expect(nameField().value).toBe("let-a-customer-pay-with-a-saved-card-or");

		await pickTask(user, "No task (standalone worktree)");
		await user.click(createButton());
		expect(api.createTerminalWorktree).toHaveBeenCalledWith(
			expect.objectContaining({ name: "let-a-customer-pay-with-a-saved-card-or", taskId: undefined }),
		);
	});

	it("sends the task it is linked to", async () => {
		const user = userEvent.setup();
		render(<Host tasks={[task("t2", "Refunds")]} />);
		await waitFor(() => expect(api.detectMainBranch).toHaveBeenCalled());
		await pickTask(user, "Refunds");
		await user.click(createButton());
		expect(api.createTerminalWorktree).toHaveBeenCalledWith(
			expect.objectContaining({ name: "refunds", taskId: "t2", baseBranch: undefined, useLocalBranch: false }),
		);
	});

	it("shows why the worktree was not created, and forgets it once the name changes", async () => {
		api.createTerminalWorktree
			.mockResolvedValueOnce({ success: false, error: "A worktree with this name already exists" })
			.mockResolvedValueOnce({ success: false })
			.mockRejectedValueOnce(new Error("git is not installed"))
			.mockRejectedValueOnce("refused");
		const user = userEvent.setup();
		render(<Host />);
		await waitFor(() => expect(api.detectMainBranch).toHaveBeenCalled());
		fireEvent.change(nameField(), { target: { value: "cart" } });

		await user.click(createButton());
		expect(screen.getByText("A worktree with this name already exists")).toBeTruthy();
		fireEvent.change(nameField(), { target: { value: "cart-2" } });
		expect(screen.queryByText("A worktree with this name already exists")).toBeNull();

		await user.click(createButton());
		expect(screen.getByText("An error occurred")).toBeTruthy();
		await user.click(createButton());
		expect(screen.getByText("git is not installed")).toBeTruthy();
		await user.click(createButton());
		expect(screen.getByText("An error occurred")).toBeTruthy();
		expect(onWorktreeCreated).not.toHaveBeenCalled();
	});

	it("locks the form while the worktree is being created", async () => {
		const pending = deferred<{ success: boolean; config: TerminalWorktreeConfig }>();
		api.createTerminalWorktree.mockReturnValue(pending.promise);
		const user = userEvent.setup();
		render(<Host />);
		await waitFor(() => expect(api.detectMainBranch).toHaveBeenCalled());
		fireEvent.change(nameField(), { target: { value: "cart" } });
		await user.click(createButton());

		expect(screen.getByRole("button", { name: "Creating..." })).toHaveProperty("disabled", true);
		expect(screen.getByRole("button", { name: "Cancel" })).toHaveProperty("disabled", true);
		expect(nameField().disabled).toBe(true);
		await act(async () => pending.resolve({ success: true, config: CONFIG }));
		expect(onWorktreeCreated).toHaveBeenCalledWith(CONFIG);
	});

	it("starts again from an empty form after Cancel, Escape or a success", async () => {
		const user = userEvent.setup();
		render(<Host tasks={[task("t2", "Refunds")]} />);
		await waitFor(() => expect(api.detectMainBranch).toHaveBeenCalled());
		const fill = async () => {
			fireEvent.change(nameField(), { target: { value: "cart" } });
			await pickTask(user, "Refunds");
			await user.click(screen.getByRole("switch"));
			await pickBaseBranch(user, "feature/cart");
		};
		const expectEmpty = async () => {
			await user.click(screen.getByRole("button", { name: "reopen" }));
			await waitFor(() => expect(nameField().value).toBe(""));
			expect(screen.getByRole("combobox", { name: /Link to Task/ }).textContent).toContain("No task");
			expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true");
			expect(screen.getByRole("combobox", { name: /Base Branch/ }).textContent).toContain(
				"Use project default (develop)",
			);
		};

		await fill();
		await user.click(screen.getByRole("button", { name: "Cancel" }));
		expect(onOpenChange).toHaveBeenLastCalledWith(false);
		await expectEmpty();

		await fill();
		await user.keyboard("{Escape}");
		await expectEmpty();

		await fill();
		await user.click(createButton());
		await expectEmpty();
	});

	it("falls back to main when the branches cannot be listed", async () => {
		api.getGitBranchesWithInfo.mockResolvedValue({ success: false, error: "not a git repository" });
		api.detectMainBranch.mockResolvedValue({ success: false });
		const user = userEvent.setup();
		render(<Host />);
		await waitFor(() => expect(api.detectMainBranch).toHaveBeenCalled());
		await waitFor(() => expect(screen.getByRole("combobox", { name: /Base Branch/ })).toHaveProperty("disabled", false));
		await user.click(screen.getByRole("combobox", { name: /Base Branch/ }));
		expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Use project default (main)"]);
	});

	it("logs a branch listing that throws, and still lets the user choose", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		api.getGitBranchesWithInfo.mockRejectedValue(new Error("ipc closed"));
		render(<Host />);
		await waitFor(() => expect(error).toHaveBeenCalledWith("Failed to fetch branches:", expect.any(Error)));
		await waitFor(() => expect(screen.getByRole("combobox", { name: /Base Branch/ })).toHaveProperty("disabled", false));
		error.mockRestore();
	});

	it("drops a branch list that arrives after the dialog was closed", async () => {
		const stale = deferred<{ success: boolean; data: GitBranchDetail[] }>();
		api.getGitBranchesWithInfo.mockReturnValueOnce(stale.promise);
		const user = userEvent.setup();
		render(<Host />);
		await user.keyboard("{Escape}");
		await user.click(screen.getByRole("button", { name: "reopen" }));
		await waitFor(() => expect(screen.getByText("Use project default (develop)")).toBeTruthy());
		await act(async () =>
			stale.resolve({ success: true, data: [{ name: "stale", displayName: "stale", type: "local" } as GitBranchDetail] }),
		);
		await user.click(screen.getByRole("combobox", { name: /Base Branch/ }));
		expect(screen.queryByRole("option", { name: /stale/ })).toBeNull();
		expect(api.detectMainBranch).toHaveBeenCalledTimes(1);
	});

	it("drops a main branch that arrives after the dialog was closed", async () => {
		const stale = deferred<{ success: boolean; data: string }>();
		api.detectMainBranch.mockReturnValueOnce(stale.promise);
		const user = userEvent.setup();
		render(<Host />);
		await waitFor(() => expect(api.detectMainBranch).toHaveBeenCalledTimes(1));
		await user.keyboard("{Escape}");
		await user.click(screen.getByRole("button", { name: "reopen" }));
		await waitFor(() => expect(screen.getByText("Use project default (develop)")).toBeTruthy());
		await act(async () => stale.resolve({ success: true, data: "stale-main" }));
		expect(screen.getByText("Use project default (develop)")).toBeTruthy();
	});
});
