/**
 * The repository block on a project's General settings pane: the checkout path
 * and the facts that go with it, shown whether or not `.workpilot/` exists yet.
 *
 * @vitest-environment jsdom
 */
import { render, waitFor } from "@testing-library/react";
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

function renderSection(project: Project, settings: ProjectSettings) {
	return render(
		<TooltipProvider>
			<RepositorySection project={project} settings={settings} />
		</TooltipProvider>,
	);
}

describe("RepositorySection", () => {
	const getCurrentGitBranch = vi.fn();
	const detectRepoProvider = vi.fn();

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
		Object.assign(globalThis, {
			electronAPI: { getCurrentGitBranch, detectRepoProvider },
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
		const { getByText } = renderSection(createProject(), baseSettings);
		expect(getByText(/Auto-detected/i)).toBeTruthy();
	});

	it("shows the configured main branch when there is one", () => {
		const { getByText } = renderSection(createProject(), {
			...baseSettings,
			mainBranch: "develop",
		});
		expect(getByText("develop")).toBeTruthy();
	});

	it("reads the current branch and the remote from git", async () => {
		const project = createProject();
		const { getByText } = renderSection(project, baseSettings);

		await waitFor(() => {
			expect(getByText("feature/x")).toBeTruthy();
			expect(
				getByText("https://github.com/krovomi/WorkPilot-AI.git"),
			).toBeTruthy();
		});
		expect(getCurrentGitBranch).toHaveBeenCalledWith(project.path);
		expect(detectRepoProvider).toHaveBeenCalledWith(project.path);
	});

	it("falls back to an empty state when the folder is not a git checkout", async () => {
		getCurrentGitBranch.mockResolvedValue({ success: false });
		detectRepoProvider.mockResolvedValue({ success: false });
		const { getByText } = renderSection(createProject(), baseSettings);

		await waitFor(() => {
			expect(getByText(/Unavailable/i)).toBeTruthy();
			expect(getByText(/No remote configured/i)).toBeTruthy();
		});
	});
});
