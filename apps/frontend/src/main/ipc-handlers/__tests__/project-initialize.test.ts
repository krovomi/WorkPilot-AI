/**
 * `project:initialize` on a checkout that already carries `.workpilot/`.
 *
 * The initializer reports that case as a failure with an `already-initialized`
 * blocker, and the handler used to pass it straight through — without stamping
 * `autoBuildPath` on the stored record. The settings pane then showed "Not
 * Initialized" above a note telling the user to reopen the settings to refresh
 * the status, and reopening changed nothing: the record it re-read was the same
 * un-stamped one. The only way out was re-adding the project.
 *
 * @vitest-environment node
 */
import { ipcMain } from "electron";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { InitializationResult } from "../../../shared/types";

const initializeProject = vi.fn<(projectPath: string) => InitializationResult>();
const updateAutoBuildPath = vi.fn();
const getProject = vi.fn();

vi.mock("../../project-initializer", () => ({
	initializeProject: (projectPath: string) => initializeProject(projectPath),
	initializeGit: vi.fn(),
	isInitialized: vi.fn(() => true),
	hasLocalSource: vi.fn(() => false),
	checkGitStatusAsync: vi.fn(),
}));

vi.mock("../../project-store", () => ({
	projectStore: {
		getProject: (id: string) => getProject(id),
		updateAutoBuildPath: (id: string, p: string) => updateAutoBuildPath(id, p),
		getProjects: vi.fn(() => []),
		addProject: vi.fn(),
		removeProject: vi.fn(),
		updateProjectSettings: vi.fn(),
		renameProject: vi.fn(),
		updateProjectPath: vi.fn(),
		getTabState: vi.fn(),
		setTabState: vi.fn(),
	},
}));

// Services pulled in at module load; none of them are exercised here.
vi.mock("../../app-emulator-service", () => ({ appEmulatorService: {} }));
vi.mock("../../changelog-service", () => ({ changelogService: {} }));
vi.mock("../../insights-service", () => ({ insightsService: {} }));
vi.mock("../../test-generation-service", () => ({ testGenerationService: {} }));
vi.mock("../../title-generator", () => ({ titleGenerator: {} }));
vi.mock("../../cli-tool-manager", () => ({ getToolPath: vi.fn() }));
vi.mock("../../updater/path-resolver", () => ({
	getEffectiveSourcePath: vi.fn(() => "/tmp/source"),
}));

const PROJECT = {
	id: "proj-1",
	name: "test",
	path: "/tmp/checkout",
	autoBuildPath: "",
};

/**
 * Registration also kicks off the Python environment bootstrap, which this test
 * has no use for: the stub reports an environment that never becomes ready, so
 * the bootstrap gives up instead of rejecting into the run.
 */
const pythonEnvManager = {
	on: () => undefined,
	initialize: async () => ({ ready: false, pythonPath: null }),
} as never;

async function invokeInitialize(): Promise<{
	success: boolean;
	data?: InitializationResult;
	error?: string;
}> {
	return (await (
		ipcMain as unknown as {
			invokeHandler: (
				channel: string,
				event: unknown,
				...args: unknown[]
			) => Promise<unknown>;
		}
	).invokeHandler("project:initialize", {}, PROJECT.id)) as {
		success: boolean;
		data?: InitializationResult;
		error?: string;
	};
}

describe("project:initialize", () => {
	beforeAll(async () => {
		const { registerProjectHandlers } = await import("../project-handlers");
		registerProjectHandlers(pythonEnvManager, {} as never, () => null);
	});

	beforeEach(() => {
		vi.clearAllMocks();
		getProject.mockReturnValue({ ...PROJECT });
	});

	it("stamps autoBuildPath and reports success when .workpilot already exists", async () => {
		initializeProject.mockReturnValue({
			success: false,
			error: "Project already has auto-claude initialized (.workpilot exists)",
			blocker: "already-initialized",
		});

		const result = await invokeInitialize();

		expect(updateAutoBuildPath).toHaveBeenCalledWith(PROJECT.id, ".workpilot");
		expect(result.success).toBe(true);
		// No blocker travels back: there is nothing for the user to act on.
		expect(result.data?.blocker).toBeUndefined();
	});

	it("stamps autoBuildPath on a fresh initialization", async () => {
		initializeProject.mockReturnValue({ success: true });

		const result = await invokeInitialize();

		expect(updateAutoBuildPath).toHaveBeenCalledWith(PROJECT.id, ".workpilot");
		expect(result.success).toBe(true);
	});

	it("passes a real blocker through untouched", async () => {
		initializeProject.mockReturnValue({
			success: false,
			error: "Git repository required.",
			blocker: "not-a-git-repo",
		});

		const result = await invokeInitialize();

		expect(updateAutoBuildPath).not.toHaveBeenCalled();
		expect(result.success).toBe(false);
		expect(result.data?.blocker).toBe("not-a-git-repo");
	});
});
