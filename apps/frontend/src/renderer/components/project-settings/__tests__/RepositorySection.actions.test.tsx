/**
 * The repository block's actions: renaming the project, copying its paths,
 * opening a terminal, pointing it at another folder, switching branch,
 * editing the remote and detecting the main branch — each one says when it
 * did not happen.
 *
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../../../shared/i18n";
import type { Project, ProjectSettings } from "../../../../shared/types";
import { useProjectStore } from "../../../stores/project-store";
import { TooltipProvider } from "../../ui/tooltip";
import { RepositorySection } from "../RepositorySection";

const mocks = vi.hoisted(() => ({
	renameProject: vi.fn(),
	copyPath: vi.fn(),
}));

vi.mock("../../../stores/project-store", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../stores/project-store")>()),
	renameProject: mocks.renameProject,
}));
vi.mock("../../../lib/copy-path", () => ({ copyPath: mocks.copyPath }));

const SETTINGS: ProjectSettings = {
	model: "sonnet",
	linearSync: false,
	notifications: {
		onTaskComplete: true,
		onTaskFailed: true,
		onReviewNeeded: true,
		sound: false,
	},
};

const PROJECT: Project = {
	id: "proj-1",
	name: "demo",
	path: "/repos/demo",
	autoBuildPath: ".workpilot",
	settings: SETTINGS,
	createdAt: new Date(0),
	updatedAt: new Date(0),
};

const api = {
	getCurrentGitBranch: vi.fn(),
	detectRepoProvider: vi.fn(),
	getGitBranchesWithInfo: vi.fn(),
	setGitRemote: vi.fn(),
	checkoutGitBranch: vi.fn(),
	detectMainBranch: vi.fn(),
	openTerminal: vi.fn(),
	selectDirectory: vi.fn(),
	openExternal: vi.fn(),
};

const repathProject = vi.fn();
let latest: ProjectSettings = SETTINGS;
let previousApi: unknown;

function Host({
	project = PROJECT,
	settings = SETTINGS,
}: {
	project?: Project;
	settings?: ProjectSettings;
}) {
	const [value, setValue] = useState(settings);
	latest = value;
	return (
		<TooltipProvider>
			<RepositorySection project={project} settings={value} setSettings={setValue} />
		</TooltipProvider>
	);
}

beforeEach(async () => {
	await i18n.changeLanguage("en");
	for (const fn of [...Object.values(api), ...Object.values(mocks), repathProject]) {
		fn.mockReset();
	}
	api.getCurrentGitBranch.mockResolvedValue({ success: true, data: "main" });
	api.detectRepoProvider.mockResolvedValue({
		success: true,
		data: { remoteName: "origin", remoteUrl: "https://github.com/acme/demo.git" },
	});
	api.getGitBranchesWithInfo.mockResolvedValue({
		success: true,
		data: [{ name: "main" }, { name: "dev" }],
	});
	api.openTerminal.mockResolvedValue({ success: true });
	api.setGitRemote.mockResolvedValue({ success: true });
	api.checkoutGitBranch.mockResolvedValue({ success: true });
	mocks.copyPath.mockResolvedValue(undefined);
	mocks.renameProject.mockResolvedValue(true);
	repathProject.mockResolvedValue(true);
	useProjectStore.setState({ missingPaths: new Set<string>(), repathProject });
	previousApi = (globalThis as { electronAPI?: unknown }).electronAPI;
	(globalThis as { electronAPI?: unknown }).electronAPI = api;
});

afterEach(() => {
	(globalThis as { electronAPI?: unknown }).electronAPI = previousApi;
	vi.useRealTimers();
	vi.restoreAllMocks();
});

async function mount(props: { project?: Project; settings?: ProjectSettings } = {}) {
	const view = render(<Host {...props} />);
	await waitFor(() =>
		expect((screen.getByLabelText("Current branch") as HTMLInputElement).value).toBe(
			"main",
		),
	);
	return view;
}

const press = (name: string) =>
	act(async () => {
		fireEvent.click(screen.getByRole("button", { name }));
	});

describe("renaming", () => {
	it("saves a new name on Enter or Save, and keeps the old one otherwise", async () => {
		await mount();
		await press("Rename");
		const input = screen.getByLabelText("Project name") as HTMLInputElement;

		fireEvent.change(input, { target: { value: "  demo  " } });
		await act(async () => {
			fireEvent.keyDown(input, { key: "Enter" });
		});
		expect(mocks.renameProject).not.toHaveBeenCalled();
		expect(screen.getByRole("button", { name: "Rename" })).toBeTruthy();

		await press("Rename");
		fireEvent.change(screen.getByLabelText("Project name"), {
			target: { value: "draft" },
		});
		fireEvent.keyDown(screen.getByLabelText("Project name"), { key: "Escape" });
		await press("Rename");
		expect((screen.getByLabelText("Project name") as HTMLInputElement).value).toBe(
			"demo",
		);

		fireEvent.change(screen.getByLabelText("Project name"), {
			target: { value: "draft" },
		});
		await press("Cancel");
		await press("Rename");
		fireEvent.change(screen.getByLabelText("Project name"), {
			target: { value: " renamed " },
		});
		fireEvent.keyDown(screen.getByLabelText("Project name"), { key: "a" });
		await act(async () => {
			fireEvent.click(screen.getAllByRole("button", { name: "Save" })[0]);
		});
		expect(mocks.renameProject).toHaveBeenCalledWith("proj-1", "renamed");
		expect(screen.getByRole("button", { name: "Rename" })).toBeTruthy();
	});

	it("stays in edit mode and says so when the rename fails", async () => {
		mocks.renameProject.mockResolvedValue(false);
		await mount();
		await press("Rename");
		fireEvent.change(screen.getByLabelText("Project name"), {
			target: { value: "other" },
		});
		await act(async () => {
			fireEvent.click(screen.getAllByRole("button", { name: "Save" })[0]);
		});
		expect(screen.getByText("Could not rename the project.")).toBeTruthy();
		expect(screen.getByLabelText("Project name")).toBeTruthy();
	});

	it("follows a rename made elsewhere while not editing", async () => {
		const view = await mount();
		view.rerender(
			<TooltipProvider>
				<RepositorySection
					project={{ ...PROJECT, name: "from the tab bar" }}
					settings={SETTINGS}
					setSettings={vi.fn()}
				/>
			</TooltipProvider>,
		);
		await press("Rename");
		expect((screen.getByLabelText("Project name") as HTMLInputElement).value).toBe(
			"from the tab bar",
		);
	});
});

describe("paths", () => {
	it("copies each path under its own name, and says so briefly", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		await mount();
		await press("Copy the repository path");
		expect(mocks.copyPath).toHaveBeenCalledWith("/repos/demo");
		expect(screen.getByText("Copied")).toBeTruthy();
		await act(async () => {
			vi.advanceTimersByTime(1500);
		});
		expect(screen.queryByText("Copied")).toBeNull();

		await press("Copy the WorkPilot folder path");
		expect(mocks.copyPath).toHaveBeenLastCalledWith(".workpilot");
		await press("Copy the remote URL");
		expect(mocks.copyPath).toHaveBeenLastCalledWith("https://github.com/acme/demo.git");
	});

	it("claims no copy the clipboard refused", async () => {
		mocks.copyPath.mockRejectedValue(new Error("denied"));
		await mount();
		await press("Copy the repository path");
		expect(screen.queryByText("Copied")).toBeNull();
	});

	it("opens a terminal at the repository, or says why not", async () => {
		await mount();
		await press("Open a terminal");
		expect(api.openTerminal).toHaveBeenCalledWith("/repos/demo");
		expect(screen.queryByText("Could not open a terminal.")).toBeNull();

		api.openTerminal.mockResolvedValueOnce({ success: false, error: "no terminal app" });
		await press("Open a terminal");
		expect(screen.getByText("no terminal app")).toBeTruthy();

		api.openTerminal.mockResolvedValueOnce({ success: false });
		await press("Open a terminal");
		expect(screen.getByText("Could not open a terminal.")).toBeTruthy();

		api.openTerminal.mockRejectedValueOnce(new Error("ipc"));
		await press("Open a terminal");
		expect(screen.getByText("Could not open a terminal.")).toBeTruthy();
	});

	it("points the project at another folder, or says why not", async () => {
		await mount();
		api.selectDirectory.mockResolvedValueOnce(null);
		await press("Change folder…");
		expect(repathProject).not.toHaveBeenCalled();

		api.selectDirectory.mockResolvedValueOnce("/repos/moved");
		await press("Change folder…");
		expect(repathProject).toHaveBeenCalledWith("proj-1", "/repos/moved");
		expect(screen.queryByText("Could not change the folder.")).toBeNull();

		repathProject.mockResolvedValueOnce(false);
		api.selectDirectory.mockResolvedValueOnce("/repos/elsewhere");
		await press("Change folder…");
		expect(screen.getByText("Could not change the folder.")).toBeTruthy();

		api.selectDirectory.mockRejectedValueOnce(new Error("dialog"));
		await press("Change folder…");
		expect(screen.getByText("Could not change the folder.")).toBeTruthy();
	});

	it("reads nothing from a folder that is gone, and offers to find it", async () => {
		useProjectStore.setState({ missingPaths: new Set(["proj-1"]) });
		render(<Host />);
		await act(() => Promise.resolve());
		expect(api.getCurrentGitBranch).not.toHaveBeenCalled();
		expect(screen.getByRole("button", { name: "Open a terminal" })).toHaveProperty(
			"disabled",
			true,
		);
		expect(screen.getByRole("button", { name: "Change folder…" })).toHaveProperty(
			"disabled",
			false,
		);
	});
});

describe("git rows", () => {
	it("waits for git before showing the branch and the remote", async () => {
		api.getCurrentGitBranch.mockReturnValue(new Promise(() => undefined));
		render(<Host />);
		await act(() => Promise.resolve());
		expect(screen.queryByLabelText("Current branch")).toBeNull();
		expect(screen.queryByLabelText("Remote URL")).toBeNull();
	});

	it("keeps the rows empty when git cannot be asked", async () => {
		api.getCurrentGitBranch.mockRejectedValue(new Error("not a repository"));
		render(<Host />);
		await waitFor(() =>
			expect(screen.getByText("Unavailable (not a git checkout?)")).toBeTruthy(),
		);
		expect(screen.getByText("No remote configured")).toBeTruthy();
	});

	it("keeps only the newest read when an older one lands late", async () => {
		let late: (v: unknown) => void = () => undefined;
		api.getCurrentGitBranch.mockReturnValueOnce(
			new Promise((resolve) => {
				late = resolve;
			}),
		);
		const view = render(<Host />);
		api.getCurrentGitBranch.mockResolvedValue({ success: true, data: "trunk" });
		view.rerender(<Host project={{ ...PROJECT, path: "/repos/other" }} />);
		await waitFor(() =>
			expect((screen.getByLabelText("Current branch") as HTMLInputElement).value).toBe(
				"trunk",
			),
		);
		await act(async () => late({ success: true, data: "stale" }));
		expect((screen.getByLabelText("Current branch") as HTMLInputElement).value).toBe(
			"trunk",
		);
	});

	it("reads no branch from a repository without one, and drops a late failure", async () => {
		let late: (e: unknown) => void = () => undefined;
		api.getCurrentGitBranch.mockReturnValueOnce(
			new Promise((_resolve, reject) => {
				late = reject;
			}),
		);
		const view = render(<Host />);
		api.getCurrentGitBranch.mockResolvedValue({ success: true });
		view.rerender(<Host project={{ ...PROJECT, path: "/repos/empty" }} />);
		await waitFor(() =>
			expect(screen.getByText("Unavailable (not a git checkout?)")).toBeTruthy(),
		);
		await act(async () => late(new Error("old read")));
		expect((screen.getByLabelText("Remote URL") as HTMLInputElement).value).toBe(
			"https://github.com/acme/demo.git",
		);
	});

	it("switches branch on Enter, and not to the branch it is on", async () => {
		await mount();
		const input = screen.getByLabelText("Current branch");
		await act(async () => {
			fireEvent.keyDown(input, { key: "Enter" });
		});
		expect(api.checkoutGitBranch).not.toHaveBeenCalled();

		fireEvent.change(input, { target: { value: "dev" } });
		fireEvent.keyDown(input, { key: "x" });
		await act(async () => {
			fireEvent.keyDown(input, { key: "Enter" });
		});
		expect(api.checkoutGitBranch).toHaveBeenCalledWith("/repos/demo", "dev");
	});

	it("explains a switch that failed without a reason, or threw", async () => {
		await mount();
		const input = screen.getByLabelText("Current branch");
		fireEvent.change(input, { target: { value: "dev" } });

		api.checkoutGitBranch.mockResolvedValueOnce({ success: false });
		await press("Switch");
		expect(screen.getByText("Could not switch branch.")).toBeTruthy();

		api.checkoutGitBranch.mockRejectedValueOnce(new Error("git died"));
		await press("Switch");
		expect(screen.getByText("git died")).toBeTruthy();

		api.checkoutGitBranch.mockRejectedValueOnce("plain");
		await press("Switch");
		expect(screen.getByText("plain")).toBeTruthy();
	});

	it("saves the remote on Enter, says so, and opens a web remote", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		await mount();
		const url = screen.getByLabelText("Remote URL");
		fireEvent.change(url, { target: { value: "https://github.com/acme/fork.git" } });
		fireEvent.change(screen.getByLabelText("Remote name"), { target: { value: "  " } });
		fireEvent.keyDown(url, { key: "a" });
		await act(async () => {
			fireEvent.keyDown(url, { key: "Enter" });
		});
		expect(api.setGitRemote).toHaveBeenCalledWith(
			"/repos/demo",
			"origin",
			"https://github.com/acme/fork.git",
			"origin",
		);
		expect(screen.getByText("Saved")).toBeTruthy();
		await act(async () => {
			vi.advanceTimersByTime(2000);
		});
		expect(screen.queryByText("Saved")).toBeNull();

		await press("Open");
		expect(api.openExternal).toHaveBeenCalledWith("https://github.com/acme/demo.git");
	});

	it("offers no browser for an SSH remote, and sends no previous name without one", async () => {
		api.detectRepoProvider.mockResolvedValue({
			success: true,
			data: { remoteUrl: "git@github.com:acme/demo.git" },
		});
		await mount();
		expect(screen.queryByRole("button", { name: "Open" })).toBeNull();
		fireEvent.change(screen.getByLabelText("Remote name"), {
			target: { value: "upstream" },
		});
		await press("Save");
		expect(api.setGitRemote).toHaveBeenCalledWith(
			"/repos/demo",
			"upstream",
			"git@github.com:acme/demo.git",
			undefined,
		);
	});

	it("explains a remote that could not be saved", async () => {
		await mount();
		fireEvent.change(screen.getByLabelText("Remote URL"), {
			target: { value: "https://example.com/x.git" },
		});
		api.setGitRemote.mockResolvedValueOnce({ success: false });
		await press("Save");
		expect(screen.getByText("Could not save the remote.")).toBeTruthy();

		api.setGitRemote.mockResolvedValueOnce({ success: false, error: "bad url" });
		await press("Save");
		expect(screen.getByText("bad url")).toBeTruthy();

		api.setGitRemote.mockRejectedValueOnce(new Error("ipc"));
		await press("Save");
		expect(screen.getByText("ipc")).toBeTruthy();

		api.setGitRemote.mockRejectedValueOnce(7);
		await press("Save");
		expect(screen.getByText("7")).toBeTruthy();
	});
});

describe("main branch", () => {
	it("takes the branch git detects", async () => {
		api.detectMainBranch.mockResolvedValue({ success: true, data: "develop" });
		await mount();
		await press("Auto-detect");
		expect(api.detectMainBranch).toHaveBeenCalledWith("/repos/demo");
		expect(latest.mainBranch).toBe("develop");
		expect(screen.getByText(/Base branch for task worktrees/)).toBeTruthy();
	});

	it("says when no main branch could be detected", async () => {
		await mount();
		api.detectMainBranch.mockResolvedValueOnce({ success: true, data: null });
		await press("Auto-detect");
		expect(screen.getByText("No main branch found: type one.")).toBeTruthy();
		expect(latest.mainBranch).toBeUndefined();

		api.detectMainBranch.mockResolvedValueOnce({ success: true, data: "main" });
		await press("Auto-detect");
		expect(screen.queryByText("No main branch found: type one.")).toBeNull();

		api.detectMainBranch.mockResolvedValueOnce({ success: false, data: "main" });
		await press("Auto-detect");
		expect(screen.getByText("No main branch found: type one.")).toBeTruthy();

		api.detectMainBranch.mockRejectedValueOnce(new Error("ipc"));
		await press("Auto-detect");
		expect(screen.getByText("No main branch found: type one.")).toBeTruthy();
	});

	it("shows a pinned main branch read-only without a setter", () => {
		render(
			<TooltipProvider>
				<RepositorySection project={PROJECT} settings={{ ...SETTINGS, mainBranch: "trunk" }} />
			</TooltipProvider>,
		);
		expect(screen.getByText("trunk").tagName).toBe("CODE");
	});

	it("speaks French", async () => {
		await i18n.changeLanguage("fr");
		api.openTerminal.mockResolvedValue({ success: false });
		render(<Host />);
		await waitFor(() => expect(api.getCurrentGitBranch).toHaveBeenCalled());
		fireEvent.click(screen.getByRole("button", { name: "Ouvrir un terminal" }));
		expect(await screen.findByText("Impossible d'ouvrir un terminal.")).toBeTruthy();
	});
});
