/**
 * The repository block on a project's General settings pane: the checkout path
 * and the facts that go with it, shown whether or not `.workpilot/` exists yet.
 *
 * @vitest-environment jsdom
 */
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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
});
