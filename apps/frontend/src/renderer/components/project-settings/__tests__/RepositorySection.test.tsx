/**
 * The repository block on a project's General settings pane: the checkout path
 * and the facts that go with it, shown whether or not `.workpilot/` exists yet,
 * and every one of them editable.
 *
 * @vitest-environment jsdom
 */
import { fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, ProjectSettings } from "../../../../shared/types";
import { TooltipProvider } from "../../ui/tooltip";
import { RepositorySection } from "../RepositorySection";

const baseSettings: ProjectSettings = {
	model: "claude-3-haiku-20240307",
	memoryBackend: "file",
	linearSync: false,
	notifications: {
		onTaskComplete: true,
		onTaskFailed: true,
		onReviewNeeded: true,
		sound: false,
	},
	graphitiMcpEnabled: false,
};

function createProject(overrides: Partial<Project> = {}): Project {
	return {
		id: "proj-1",
		name: "test",
		path: "/home/leub/repositories/test",
		autoBuildPath: "/home/leub/repositories/test/.workpilot",
		settings: baseSettings,
		createdAt: new Date(),
		updatedAt: new Date(),
		...overrides,
	};
}

function renderSection(
	project: Project,
	settings: ProjectSettings,
	setSettings?: React.Dispatch<React.SetStateAction<ProjectSettings>>,
) {
	return render(
		<TooltipProvider>
			<RepositorySection
				project={project}
				settings={settings}
				setSettings={setSettings}
			/>
		</TooltipProvider>,
	);
}

describe("RepositorySection", () => {
	const getCurrentGitBranch = vi.fn();
	const detectRepoProvider = vi.fn();
	const getGitBranchesWithInfo = vi.fn();
	const setGitRemote = vi.fn();
	const checkoutGitBranch = vi.fn();
	const detectMainBranch = vi.fn();

	beforeEach(() => {
		getCurrentGitBranch.mockResolvedValue({ success: true, data: "feature/x" });
		detectRepoProvider.mockResolvedValue({
			success: true,
			data: {
				provider: "github",
				remoteName: "origin",
				remoteUrl: "https://github.com/krovomi/WorkPilot-AI.git",
			},
		});
		getGitBranchesWithInfo.mockResolvedValue({
			success: true,
			data: [
				{ name: "main", type: "local", displayName: "main", isCurrent: false },
				{
					name: "feature/x",
					type: "local",
					displayName: "feature/x",
					isCurrent: true,
				},
			],
		});
		setGitRemote.mockResolvedValue({ success: true, data: {} });
		checkoutGitBranch.mockResolvedValue({ success: true, data: "main" });
		detectMainBranch.mockResolvedValue({ success: true, data: "develop" });
		Object.assign(globalThis, {
			electronAPI: {
				getCurrentGitBranch,
				detectRepoProvider,
				getGitBranchesWithInfo,
				setGitRemote,
				checkoutGitBranch,
				detectMainBranch,
			},
		});
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("shows the repository path and the WorkPilot folder", () => {
		const project = createProject();
		const { getByText } = renderSection(project, baseSettings);

		expect(getByText(project.path)).toBeTruthy();
		expect(getByText(project.autoBuildPath)).toBeTruthy();
		expect(getByText("test")).toBeTruthy();
	});

	it("still shows the repository path when WorkPilot AI is not initialized", () => {
		// The whole point of living outside the initialization gate: an
		// uninitialized project is exactly when someone checks the path.
		const project = createProject({ autoBuildPath: "" });
		const { getByText } = renderSection(project, baseSettings);

		expect(getByText(project.path)).toBeTruthy();
		expect(getByText(/Not created yet/i)).toBeTruthy();
	});

	it("falls back to an auto-detected main branch when none is configured", () => {
		const { getByText } = renderSection(createProject(), baseSettings, vi.fn());
		expect(getByText(/Auto-detected/i)).toBeTruthy();
	});

	it("shows the configured main branch when there is one", () => {
		const { getByLabelText } = renderSection(
			createProject(),
			{ ...baseSettings, mainBranch: "develop" },
			vi.fn(),
		);
		expect((getByLabelText("Main branch") as HTMLInputElement).value).toBe(
			"develop",
		);
	});

	it("reads the current branch and the remote from git", async () => {
		const project = createProject();
		const { getByLabelText } = renderSection(project, baseSettings);

		await waitFor(() => {
			expect((getByLabelText("Current branch") as HTMLInputElement).value).toBe(
				"feature/x",
			);
			expect((getByLabelText("Remote URL") as HTMLInputElement).value).toBe(
				"https://github.com/krovomi/WorkPilot-AI.git",
			);
		});
		expect(getCurrentGitBranch).toHaveBeenCalledWith(project.path);
		expect(detectRepoProvider).toHaveBeenCalledWith(project.path);
	});

	it("falls back to an empty state when the folder is not a git checkout", async () => {
		getCurrentGitBranch.mockResolvedValue({ success: false });
		detectRepoProvider.mockResolvedValue({ success: false });
		getGitBranchesWithInfo.mockResolvedValue({ success: false });
		const { getByText } = renderSection(createProject(), baseSettings);

		await waitFor(() => {
			expect(getByText(/Unavailable/i)).toBeTruthy();
			expect(getByText(/No remote configured/i)).toBeTruthy();
		});
	});

	it("switches branch, then re-reads git rather than trusting the draft", async () => {
		const project = createProject();
		const { getByLabelText, getByText } = renderSection(project, baseSettings);

		const input = await waitFor(() => {
			const el = getByLabelText("Current branch") as HTMLInputElement;
			expect(el.value).toBe("feature/x");
			return el;
		});

		fireEvent.change(input, { target: { value: "main" } });
		getCurrentGitBranch.mockResolvedValue({ success: true, data: "main" });
		fireEvent.click(getByText("Switch"));

		await waitFor(() => {
			expect(checkoutGitBranch).toHaveBeenCalledWith(project.path, "main");
		});
		// Two reads: the mount, and the refresh the successful switch triggers.
		await waitFor(() => {
			expect(getCurrentGitBranch).toHaveBeenCalledTimes(2);
		});
	});

	it("reports git's own refusal instead of a generic failure", async () => {
		checkoutGitBranch.mockResolvedValue({
			success: false,
			error: "error: Your local changes would be overwritten by checkout.",
		});
		const { getByLabelText, getByText } = renderSection(
			createProject(),
			baseSettings,
		);

		const input = await waitFor(() => {
			const el = getByLabelText("Current branch") as HTMLInputElement;
			expect(el.value).toBe("feature/x");
			return el;
		});
		fireEvent.change(input, { target: { value: "main" } });
		fireEvent.click(getByText("Switch"));

		await waitFor(() => {
			expect(getByText(/local changes would be overwritten/i)).toBeTruthy();
		});
	});

	it("configures a remote on a checkout that has none", async () => {
		detectRepoProvider.mockResolvedValue({
			success: true,
			data: { provider: "unknown", remoteName: "origin" },
		});
		const project = createProject();
		const { getByLabelText, getAllByText } = renderSection(
			project,
			baseSettings,
		);

		const urlInput = await waitFor(
			() => getByLabelText("Remote URL") as HTMLInputElement,
		);
		expect(urlInput.value).toBe("");

		fireEvent.change(urlInput, {
			target: { value: "git@github.com:krovomi/WorkPilot-AI.git" },
		});
		// Two "Save" buttons can exist (name edit is collapsed, so only the
		// remote's is rendered); take the last to be explicit about which.
		const saveButtons = getAllByText("Save");
		fireEvent.click(saveButtons[saveButtons.length - 1]);

		await waitFor(() => {
			expect(setGitRemote).toHaveBeenCalledWith(
				project.path,
				"origin",
				"git@github.com:krovomi/WorkPilot-AI.git",
				"origin",
			);
		});
	});

	it("sends the previous remote name so an edited one is renamed, not duplicated", async () => {
		const project = createProject();
		const { getByLabelText, getAllByText } = renderSection(
			project,
			baseSettings,
		);

		const nameInput = await waitFor(() => {
			const el = getByLabelText("Remote name") as HTMLInputElement;
			expect(el.value).toBe("origin");
			return el;
		});
		fireEvent.change(nameInput, { target: { value: "upstream" } });
		const saveButtons = getAllByText("Save");
		fireEvent.click(saveButtons[saveButtons.length - 1]);

		await waitFor(() => {
			expect(setGitRemote).toHaveBeenCalledWith(
				project.path,
				"upstream",
				"https://github.com/krovomi/WorkPilot-AI.git",
				"origin",
			);
		});
	});

	it("writes the main branch into settings rather than to git", async () => {
		const setSettings = vi.fn();
		const { getByLabelText } = renderSection(
			createProject(),
			baseSettings,
			setSettings,
		);

		fireEvent.change(getByLabelText("Main branch"), {
			target: { value: "develop" },
		});

		expect(setSettings).toHaveBeenCalledTimes(1);
		const updater = setSettings.mock.calls[0][0] as (
			prev: ProjectSettings,
		) => ProjectSettings;
		expect(updater(baseSettings).mainBranch).toBe("develop");
		expect(setGitRemote).not.toHaveBeenCalled();
		expect(checkoutGitBranch).not.toHaveBeenCalled();
	});

	it("clears the main branch back to auto-detection, not to an empty string", () => {
		// Every reader of `mainBranch` falls back only on a falsy value, so ""
		// and undefined must not be allowed to mean different things.
		const setSettings = vi.fn();
		const { getByLabelText } = renderSection(
			createProject(),
			{ ...baseSettings, mainBranch: "develop" },
			setSettings,
		);

		fireEvent.change(getByLabelText("Main branch"), { target: { value: "  " } });

		const updater = setSettings.mock.calls[0][0] as (
			prev: ProjectSettings,
		) => ProjectSettings;
		expect(updater(baseSettings).mainBranch).toBeUndefined();
	});

	it("reports the main branch read-only when no setter is given", () => {
		const { getByText, queryByLabelText } = renderSection(createProject(), {
			...baseSettings,
			mainBranch: "develop",
		});
		expect(getByText("develop")).toBeTruthy();
		expect(queryByLabelText("Main branch")).toBeNull();
	});
});
