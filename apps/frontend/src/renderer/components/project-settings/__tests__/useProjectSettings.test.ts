/**
 * The state behind a project's settings pane: what it loads when it opens,
 * the connections it checks, initialization and its git repair, and the two
 * ways a change reaches disk (field auto-save and the Save button).
 *
 * @vitest-environment jsdom
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	Project,
	ProjectEnvConfig,
	ProjectSettings,
} from "../../../../shared/types";

const stores = vi.hoisted(() => ({
	checkGitHubConnection: vi.fn(),
	setProjectEnvConfig: vi.fn(),
	checkProjectVersion: vi.fn(),
	initializeProject: vi.fn(),
	refreshProjects: vi.fn(),
	updateProjectSettings: vi.fn(),
}));

vi.mock("../../../stores/github", () => ({
	checkGitHubConnection: stores.checkGitHubConnection,
}));
vi.mock("../../../stores/project-env-store", () => ({
	setProjectEnvConfig: stores.setProjectEnvConfig,
}));
vi.mock("../../../stores/project-store", () => ({
	checkProjectVersion: stores.checkProjectVersion,
	initializeProject: stores.initializeProject,
	refreshProjects: stores.refreshProjects,
	updateProjectSettings: stores.updateProjectSettings,
}));

import { useProjectSettings } from "../hooks/useProjectSettings";

const settings: ProjectSettings = {
	model: "sonnet",
	linearSync: false,
	notifications: {
		onTaskComplete: true,
		onTaskFailed: true,
		onReviewNeeded: true,
		sound: false,
	},
};

function project(overrides: Partial<Project> = {}): Project {
	return {
		id: "proj-1",
		name: "demo",
		path: "/repos/demo",
		autoBuildPath: "/repos/demo/.workpilot",
		settings,
		createdAt: new Date(0),
		updatedAt: new Date(0),
		...overrides,
	};
}

function env(overrides: Partial<ProjectEnvConfig> = {}): ProjectEnvConfig {
	return {
		claudeAuthStatus: "not_configured",
		linearEnabled: false,
		githubEnabled: false,
		gitlabEnabled: false,
		azureDevOpsEnabled: false,
		...overrides,
	} as ProjectEnvConfig;
}

const api = {
	getProjectEnv: vi.fn(),
	checkClaudeAuth: vi.fn(),
	checkLinearConnection: vi.fn(),
	checkAzureDevOpsConnection: vi.fn(),
	checkGitLabConnection: vi.fn(),
	initializeGit: vi.fn(),
	invokeClaudeSetup: vi.fn(),
	updateProjectEnv: vi.fn(),
};

let previousApi: unknown;

beforeEach(() => {
	for (const fn of [...Object.values(api), ...Object.values(stores)]) {
		fn.mockReset();
	}
	api.getProjectEnv.mockResolvedValue({ success: true, data: env() });
	api.checkClaudeAuth.mockResolvedValue({
		success: true,
		data: { authenticated: true },
	});
	api.updateProjectEnv.mockResolvedValue({ success: true });
	stores.checkProjectVersion.mockResolvedValue({
		success: true,
		data: { isInitialized: true },
	});
	stores.updateProjectSettings.mockResolvedValue(true);
	stores.refreshProjects.mockResolvedValue(true);
	previousApi = (window as unknown as { electronAPI: unknown }).electronAPI;
	(window as unknown as { electronAPI: unknown }).electronAPI = api;
});

afterEach(() => {
	(window as unknown as { electronAPI: unknown }).electronAPI = previousApi;
	vi.restoreAllMocks();
});

async function opened(p = project()) {
	const hook = renderHook(
		({ proj, open }) => useProjectSettings(proj, open),
		{ initialProps: { proj: p, open: true } },
	);
	await waitFor(() => expect(hook.result.current.isLoadingEnv).toBe(false));
	await waitFor(() =>
		expect(hook.result.current.isCheckingClaudeAuth).toBe(false),
	);
	await waitFor(() => expect(hook.result.current.isCheckingVersion).toBe(false));
	return hook;
}

describe("opening the pane", () => {
	it("loads the version, the environment and the Claude sign-in", async () => {
		const loaded = env({ githubRepo: "owner/repo" });
		api.getProjectEnv.mockResolvedValue({ success: true, data: loaded });
		const { result } = await opened();

		expect(result.current.versionInfo).toEqual({ isInitialized: true });
		expect(result.current.envConfig).toBe(loaded);
		expect(stores.setProjectEnvConfig).toHaveBeenCalledWith("proj-1", loaded);
		expect(result.current.claudeAuthStatus).toBe("authenticated");
		expect(result.current.settings).toBe(settings);
	});

	it("loads nothing while closed or before initialization", async () => {
		renderHook(() => useProjectSettings(project(), false));
		renderHook(() =>
			useProjectSettings(project({ autoBuildPath: undefined }), true),
		);
		await act(() => Promise.resolve());
		expect(api.getProjectEnv).not.toHaveBeenCalled();
		expect(api.checkClaudeAuth).not.toHaveBeenCalled();
		expect(stores.checkProjectVersion).not.toHaveBeenCalled();
	});

	it("reports each load that fails", async () => {
		stores.checkProjectVersion.mockResolvedValue({ success: false });
		api.getProjectEnv.mockResolvedValue({ success: false, error: "no file" });
		api.checkClaudeAuth.mockResolvedValue({ success: false });
		const { result } = await opened();

		expect(result.current.versionInfo).toBeNull();
		expect(result.current.envError).toBe("no file");
		expect(result.current.claudeAuthStatus).toBe("error");
	});

	it("falls back to a generic message and handles thrown errors", async () => {
		api.getProjectEnv.mockResolvedValueOnce({ success: false });
		api.checkClaudeAuth.mockRejectedValue(new Error("ipc down"));
		const first = await opened();
		expect(first.result.current.envError).toBe(
			"Failed to load environment config",
		);
		expect(first.result.current.claudeAuthStatus).toBe("error");

		api.getProjectEnv.mockRejectedValueOnce(new Error("boom"));
		const second = await opened(project({ id: "proj-2" }));
		expect(second.result.current.envError).toBe("boom");

		api.getProjectEnv.mockRejectedValueOnce("not an error");
		const third = await opened(project({ id: "proj-3" }));
		expect(third.result.current.envError).toBe("Unknown error");
	});

	it("shows a signed-out Claude account as such", async () => {
		api.checkClaudeAuth.mockResolvedValue({
			success: true,
			data: { authenticated: false },
		});
		const { result } = await opened();
		expect(result.current.claudeAuthStatus).toBe("not_authenticated");
	});

	it("takes the new project's settings when the project changes", async () => {
		const hook = await opened();
		const other = { ...settings, model: "opus" };
		hook.rerender({ proj: project({ id: "proj-2", settings: other }), open: true });
		await waitFor(() => expect(hook.result.current.settings).toBe(other));
	});
});

describe("connection checks", () => {
	it("checks Linear only when it is enabled with a key", async () => {
		api.getProjectEnv.mockResolvedValue({
			success: true,
			data: env({ linearEnabled: true, linearApiKey: "fake-key" }),
		});
		api.checkLinearConnection.mockResolvedValue({
			success: true,
			data: { connected: true },
		});
		const { result } = await opened();
		await waitFor(() =>
			expect(result.current.linearConnectionStatus).toEqual({ connected: true }),
		);
		expect(result.current.isCheckingLinear).toBe(false);

		api.checkLinearConnection.mockRejectedValue(new Error("down"));
		await act(() =>
			result.current.updateEnvConfig({ linearApiKey: "fake-key-2" }),
		);
		await waitFor(() =>
			expect(result.current.linearConnectionStatus).toEqual({
				connected: false,
				error: "Failed to check connection",
			}),
		);

		// Turned off: the last result no longer describes anything.
		await act(() => result.current.updateEnvConfig({ linearEnabled: false }));
		expect(result.current.linearConnectionStatus).toBeNull();
	});

	it("keeps the previous Linear status when the check returns nothing", async () => {
		api.getProjectEnv.mockResolvedValue({
			success: true,
			data: env({ linearEnabled: true, linearApiKey: "fake-key" }),
		});
		api.checkLinearConnection.mockResolvedValue({ success: false });
		const { result } = await opened();
		await waitFor(() => expect(api.checkLinearConnection).toHaveBeenCalled());
		await waitFor(() => expect(result.current.isCheckingLinear).toBe(false));
		expect(result.current.linearConnectionStatus).toBeNull();
	});

	it("checks Azure DevOps only with its token and organization", async () => {
		api.getProjectEnv.mockResolvedValue({
			success: true,
			data: env({ azureDevOpsEnabled: true, azureDevOpsPat: "fake-pat" }),
		});
		const { result } = await opened();
		expect(api.checkAzureDevOpsConnection).not.toHaveBeenCalled();

		api.checkAzureDevOpsConnection.mockResolvedValueOnce({
			success: true,
			data: { connected: true },
		});
		await act(() =>
			result.current.updateEnvConfig({
				azureDevOpsOrgUrl: "https://dev.azure.com/org",
			}),
		);
		await waitFor(() =>
			expect(result.current.azureDevOpsConnectionStatus).toEqual({
				connected: true,
			}),
		);

		api.checkAzureDevOpsConnection.mockResolvedValueOnce({ success: false });
		await act(() => result.current.updateEnvConfig({ azureDevOpsPat: "p2" }));
		await waitFor(() =>
			expect(result.current.isCheckingAzureDevOps).toBe(false),
		);
		// New settings, no answer: the old status no longer describes them.
		expect(result.current.azureDevOpsConnectionStatus).toBeNull();

		api.checkAzureDevOpsConnection.mockRejectedValueOnce(new Error("down"));
		await act(() => result.current.updateEnvConfig({ azureDevOpsPat: "p3" }));
		await waitFor(() =>
			expect(result.current.azureDevOpsConnectionStatus).toEqual({
				connected: false,
				error: "Failed to check connection",
			}),
		);

		// Turned off: the last result no longer describes anything.
		await act(() => result.current.updateEnvConfig({ azureDevOpsEnabled: false }));
		expect(result.current.azureDevOpsConnectionStatus).toBeNull();
	});

	it("checks GitHub through the shared store", async () => {
		api.getProjectEnv.mockResolvedValue({
			success: true,
			data: env({
				githubEnabled: true,
				githubToken: "fake-token",
				githubRepo: "owner/repo",
			}),
		});
		stores.checkGitHubConnection.mockResolvedValueOnce({ connected: true });
		const { result } = await opened();
		await waitFor(() =>
			expect(result.current.gitHubConnectionStatus).toEqual({ connected: true }),
		);
		expect(stores.checkGitHubConnection).toHaveBeenCalledWith("proj-1");

		stores.checkGitHubConnection.mockResolvedValueOnce(null);
		await act(() => result.current.updateEnvConfig({ githubRepo: "o/r2" }));
		await waitFor(() => expect(result.current.isCheckingGitHub).toBe(false));
		expect(result.current.gitHubConnectionStatus).toBeNull();

		stores.checkGitHubConnection.mockRejectedValueOnce(new Error("down"));
		await act(() => result.current.updateEnvConfig({ githubRepo: "o/r3" }));
		await waitFor(() =>
			expect(result.current.gitHubConnectionStatus).toEqual({
				connected: false,
				error: "Failed to check connection",
			}),
		);

		// Turned off: the last result no longer describes anything.
		await act(() => result.current.updateEnvConfig({ githubEnabled: false }));
		expect(result.current.gitHubConnectionStatus).toBeNull();
	});

	it("checks GitLab only with its token and project", async () => {
		api.getProjectEnv.mockResolvedValue({
			success: true,
			data: env({
				gitlabEnabled: true,
				gitlabToken: "fake-token",
				gitlabProject: "group/app",
			}),
		});
		api.checkGitLabConnection.mockResolvedValueOnce({
			success: true,
			data: { connected: true },
		});
		const { result } = await opened();
		await waitFor(() =>
			expect(result.current.gitLabConnectionStatus).toEqual({ connected: true }),
		);

		api.checkGitLabConnection.mockResolvedValueOnce({ success: false });
		await act(() => result.current.updateEnvConfig({ gitlabProject: "g/b" }));
		await waitFor(() => expect(result.current.isCheckingGitLab).toBe(false));
		expect(result.current.gitLabConnectionStatus).toBeNull();

		api.checkGitLabConnection.mockRejectedValueOnce(new Error("down"));
		await act(() => result.current.updateEnvConfig({ gitlabProject: "g/c" }));
		await waitFor(() =>
			expect(result.current.gitLabConnectionStatus).toEqual({
				connected: false,
				error: "Failed to check connection",
			}),
		);

		// Turned off: the last result no longer describes anything.
		await act(() => result.current.updateEnvConfig({ gitlabEnabled: false }));
		expect(result.current.gitLabConnectionStatus).toBeNull();
	});
});

describe("initialization", () => {
	it("refreshes the project, its version and its environment", async () => {
		const { result } = await opened();
		const fresh = env({ githubEnabled: true });
		stores.initializeProject.mockResolvedValue({ success: true });
		stores.checkProjectVersion.mockResolvedValue({
			success: true,
			data: { isInitialized: true, updateAvailable: false },
		});
		api.getProjectEnv.mockResolvedValue({ success: true, data: fresh });

		await act(() => result.current.handleInitialize());

		expect(stores.refreshProjects).toHaveBeenCalled();
		expect(result.current.versionInfo).toEqual({
			isInitialized: true,
			updateAvailable: false,
		});
		expect(result.current.envConfig).toBe(fresh);
		expect(stores.setProjectEnvConfig).toHaveBeenLastCalledWith("proj-1", fresh);
		expect(result.current.isUpdating).toBe(false);
	});

	it("clears the version and keeps the environment when they cannot be read", async () => {
		const { result } = await opened();
		const before = result.current.envConfig;
		stores.initializeProject.mockResolvedValue({ success: true });
		stores.checkProjectVersion.mockResolvedValue({ success: false });
		api.getProjectEnv.mockResolvedValue({ success: false });

		await act(() => result.current.handleInitialize());

		expect(result.current.versionInfo).toBeNull();
		expect(result.current.envConfig).toBe(before);
	});

	it("records a blocker instead of an error", async () => {
		const { result } = await opened();
		stores.initializeProject.mockResolvedValue({
			success: false,
			error: "no commit",
			data: { blocker: "git-no-commits" },
		});
		await act(() => result.current.handleInitialize());
		expect(result.current.initBlocker).toBe("git-no-commits");
		expect(result.current.error).toBeNull();
	});

	it("shows the error when there is no blocker", async () => {
		const { result } = await opened();
		stores.initializeProject.mockResolvedValueOnce({
			success: false,
			error: "disk full",
		});
		await act(() => result.current.handleInitialize());
		expect(result.current.error).toBe("disk full");

		stores.initializeProject.mockResolvedValueOnce(undefined);
		await act(() => result.current.handleInitialize());
		expect(result.current.error).toBe("Failed to initialize");
		expect(result.current.initBlocker).toBeNull();

		stores.initializeProject.mockRejectedValueOnce(new Error("crash"));
		await act(() => result.current.handleInitialize());
		expect(result.current.error).toBe("crash");

		stores.initializeProject.mockRejectedValueOnce(42);
		await act(() => result.current.handleInitialize());
		expect(result.current.error).toBe("Unknown error");
		expect(result.current.isUpdating).toBe(false);
	});
});

describe("git repair", () => {
	it("prepares the repository, then initializes", async () => {
		const { result } = await opened();
		api.initializeGit.mockResolvedValue({ success: true });
		stores.initializeProject.mockResolvedValue({ success: true });
		const identity = { name: "Dev", email: "dev@example.com" };

		await act(() => result.current.handleRepairGit(identity));

		expect(api.initializeGit).toHaveBeenCalledWith(
			"/repos/demo",
			undefined,
			identity,
		);
		expect(stores.initializeProject).toHaveBeenCalledWith("proj-1");
		expect(result.current.initBlocker).toBeNull();
		expect(result.current.isRepairingGit).toBe(false);
	});

	it("asks for an identity when git has none", async () => {
		const { result } = await opened();
		api.initializeGit.mockResolvedValue({
			success: false,
			data: { blocker: "git-identity-missing" },
		});
		await act(() => result.current.handleRepairGit());
		expect(result.current.initBlocker).toBe("git-identity-missing");
		expect(stores.initializeProject).not.toHaveBeenCalled();
		expect(result.current.isRepairingGit).toBe(false);
	});

	it("reports any other failure", async () => {
		const { result } = await opened();
		api.initializeGit.mockResolvedValueOnce({ success: false, error: "locked" });
		await act(() => result.current.handleRepairGit());
		expect(result.current.error).toBe("locked");

		api.initializeGit.mockResolvedValueOnce(undefined);
		await act(() => result.current.handleRepairGit());
		expect(result.current.error).toBe("Failed to prepare the git repository");

		api.initializeGit.mockRejectedValueOnce(new Error("spawn failed"));
		await act(() => result.current.handleRepairGit());
		expect(result.current.error).toBe("spawn failed");

		api.initializeGit.mockRejectedValueOnce("x");
		await act(() => result.current.handleRepairGit());
		expect(result.current.error).toBe("Unknown error");
		expect(stores.initializeProject).not.toHaveBeenCalled();
	});
});

describe("Claude setup", () => {
	it("reloads the environment once signed in", async () => {
		const { result } = await opened();
		const fresh = env({ claudeAuthStatus: "authenticated" });
		api.invokeClaudeSetup.mockResolvedValue({
			success: true,
			data: { authenticated: true },
		});
		api.getProjectEnv.mockResolvedValue({ success: true, data: fresh });

		await act(() => result.current.handleClaudeSetup());

		expect(result.current.claudeAuthStatus).toBe("authenticated");
		expect(result.current.envConfig).toBe(fresh);
		expect(result.current.isCheckingClaudeAuth).toBe(false);
	});

	it("keeps the environment when it cannot be reloaded", async () => {
		const { result } = await opened();
		const before = result.current.envConfig;
		api.invokeClaudeSetup.mockResolvedValue({
			success: true,
			data: { authenticated: true },
		});
		api.getProjectEnv.mockResolvedValue({ success: false });
		await act(() => result.current.handleClaudeSetup());
		expect(result.current.envConfig).toBe(before);
	});

	it("changes nothing when the sign-in did not finish", async () => {
		api.checkClaudeAuth.mockResolvedValue({
			success: true,
			data: { authenticated: false },
		});
		const { result } = await opened();
		api.invokeClaudeSetup.mockResolvedValue({ success: true, data: {} });
		await act(() => result.current.handleClaudeSetup());
		expect(result.current.claudeAuthStatus).toBe("not_authenticated");
	});

	it("shows an error when the setup throws", async () => {
		const { result } = await opened();
		api.invokeClaudeSetup.mockRejectedValue(new Error("no terminal"));
		await act(() => result.current.handleClaudeSetup());
		expect(result.current.claudeAuthStatus).toBe("error");
		expect(result.current.isCheckingClaudeAuth).toBe(false);
	});
});

describe("saving", () => {
	it("saves the settings and the environment, then closes", async () => {
		const { result } = await opened();
		const onClose = vi.fn();
		await act(() => result.current.handleSave(onClose));
		expect(stores.updateProjectSettings).toHaveBeenCalledWith(
			"proj-1",
			settings,
		);
		expect(api.updateProjectEnv).toHaveBeenCalledWith(
			"proj-1",
			result.current.envConfig,
		);
		expect(onClose).toHaveBeenCalled();
		expect(result.current.isSaving).toBe(false);
	});

	it("saves only the settings when no environment is loaded", async () => {
		const { result } = renderHook(() =>
			useProjectSettings(project({ autoBuildPath: undefined }), true),
		);
		const onClose = vi.fn();
		await act(() => result.current.handleSave(onClose));
		expect(api.updateProjectEnv).not.toHaveBeenCalled();
		expect(onClose).toHaveBeenCalled();
	});

	it("stays open and explains why when a save fails", async () => {
		const { result } = await opened();
		const onClose = vi.fn();

		stores.updateProjectSettings.mockResolvedValueOnce(false);
		await act(() => result.current.handleSave(onClose));
		expect(result.current.error).toBe("Failed to save settings");

		api.updateProjectEnv.mockResolvedValueOnce({ success: false, error: "ro" });
		await act(() => result.current.handleSave(onClose));
		expect(result.current.error).toBe("ro");

		api.updateProjectEnv.mockResolvedValueOnce({ success: false });
		await act(() => result.current.handleSave(onClose));
		expect(result.current.error).toBe("Failed to save environment config");

		stores.updateProjectSettings.mockRejectedValueOnce(new Error("ipc"));
		await act(() => result.current.handleSave(onClose));
		expect(result.current.error).toBe("ipc");

		stores.updateProjectSettings.mockRejectedValueOnce(null);
		await act(() => result.current.handleSave(onClose));
		expect(result.current.error).toBe("Unknown error");

		expect(onClose).not.toHaveBeenCalled();
		expect(result.current.isSaving).toBe(false);
	});
});

describe("field auto-save", () => {
	it("applies a change at once and saves the whole configuration", async () => {
		const { result } = await opened();
		await act(() => result.current.updateEnvConfig({ githubRepo: "o/r" }));
		expect(result.current.envConfig?.githubRepo).toBe("o/r");
		expect(api.updateProjectEnv).toHaveBeenLastCalledWith(
			"proj-1",
			expect.objectContaining({ githubRepo: "o/r" }),
		);
		expect(result.current.envError).toBeNull();
	});

	it("keeps both of two quick changes", async () => {
		const { result } = await opened();
		await act(async () => {
			const first = result.current.updateEnvConfig({ githubRepo: "o/r" });
			const second = result.current.updateEnvConfig({ gitlabProject: "g/p" });
			await Promise.all([first, second]);
		});
		expect(api.updateProjectEnv).toHaveBeenLastCalledWith(
			"proj-1",
			expect.objectContaining({ githubRepo: "o/r", gitlabProject: "g/p" }),
		);
	});

	it("keeps the change on screen and shows why the save failed", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		const { result } = await opened();

		api.updateProjectEnv.mockResolvedValueOnce({ success: false, error: "ro" });
		await act(() => result.current.updateEnvConfig({ githubRepo: "a/b" }));
		expect(result.current.envError).toBe("ro");
		expect(result.current.envConfig?.githubRepo).toBe("a/b");

		api.updateProjectEnv.mockResolvedValueOnce({ success: false });
		await act(() => result.current.updateEnvConfig({ githubRepo: "c/d" }));
		expect(result.current.envError).toBe("Failed to save environment config");

		api.updateProjectEnv.mockRejectedValueOnce(new Error("ipc"));
		await act(() => result.current.updateEnvConfig({ githubRepo: "e/f" }));
		expect(result.current.envError).toBe("ipc");

		api.updateProjectEnv.mockRejectedValueOnce("x");
		await act(() => result.current.updateEnvConfig({ githubRepo: "g/h" }));
		expect(result.current.envError).toBe("Failed to save environment config");

		await act(() => result.current.updateEnvConfig({ githubRepo: "i/j" }));
		expect(result.current.envError).toBeNull();
	});

	it("saves nothing before a configuration is loaded", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const { result } = renderHook(() =>
			useProjectSettings(project({ autoBuildPath: undefined }), true),
		);
		await act(() => result.current.updateEnvConfig({ githubRepo: "o/r" }));
		expect(api.updateProjectEnv).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalled();
	});

	it("never writes one project's configuration into another", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const hook = await opened();
		api.getProjectEnv.mockReturnValue(new Promise(() => undefined));
		hook.rerender({ proj: project({ id: "proj-2" }), open: true });

		await act(() => hook.result.current.updateEnvConfig({ githubRepo: "o/r" }));

		expect(api.updateProjectEnv).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalled();
	});
});

describe("view state", () => {
	it("toggles sections and secret visibility", async () => {
		const { result } = await opened();
		expect(result.current.expandedSections).toEqual({
			claude: true,
			linear: false,
			github: false,
		});
		act(() => result.current.toggleSection("linear"));
		act(() => result.current.toggleSection("claude"));
		expect(result.current.expandedSections).toEqual({
			claude: false,
			linear: true,
			github: false,
		});

		act(() => {
			result.current.setShowClaudeToken(true);
			result.current.setShowLinearKey(true);
			result.current.setShowGitHubToken(true);
			result.current.setShowGitLabToken(true);
			result.current.setShowAzureDevOpsToken(true);
			result.current.setShowLinearImportModal(true);
			result.current.setShowAzureDevOpsImportModal(true);
		});
		expect(result.current.showClaudeToken).toBe(true);
		expect(result.current.showLinearKey).toBe(true);
		expect(result.current.showGitHubToken).toBe(true);
		expect(result.current.showGitLabToken).toBe(true);
		expect(result.current.showAzureDevOpsToken).toBe(true);
		expect(result.current.showLinearImportModal).toBe(true);
		expect(result.current.showAzureDevOpsImportModal).toBe(true);
	});
});
