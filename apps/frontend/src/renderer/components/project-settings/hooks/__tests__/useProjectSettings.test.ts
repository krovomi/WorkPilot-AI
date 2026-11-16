/**
 * The project settings dialog: the project's version, environment
 * configuration and Claude sign-in read when it opens, each integration's
 * connection checked while its settings are complete, initialization and its
 * git repair, and saving. Nothing read for one project lands on, or is saved
 * into, another.
 *
 * @vitest-environment jsdom
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
	checkProjectVersion: vi.fn(),
	initializeProject: vi.fn(),
	refreshProjects: vi.fn(),
	updateProjectSettings: vi.fn(),
	checkGitHubConnection: vi.fn(),
	setProjectEnvConfig: vi.fn(),
}));
vi.mock("../../../../stores/project-store", () => ({
	checkProjectVersion: store.checkProjectVersion,
	initializeProject: store.initializeProject,
	refreshProjects: store.refreshProjects,
	updateProjectSettings: store.updateProjectSettings,
}));
vi.mock("../../../../stores/github", () => ({ checkGitHubConnection: store.checkGitHubConnection }));
vi.mock("../../../../stores/project-env-store", () => ({ setProjectEnvConfig: store.setProjectEnvConfig }));

import { useProjectSettings } from "../useProjectSettings";

const project = (id = "p1", extra: object = {}) =>
	({ id, path: `/repos/${id}`, autoBuildPath: ".workpilot", settings: { model: id }, ...extra }) as never;
const env = (id: string, extra: object = {}) => ({ claudeOAuthToken: undefined, project: id, ...extra }) as never;

let api: Record<string, ReturnType<typeof vi.fn>>;

function deferred() {
	let resolve: (value: unknown) => void = vi.fn();
	let reject: (reason: unknown) => void = vi.fn();
	const promise = new Promise((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

beforeEach(() => {
	for (const fn of Object.values(store)) fn.mockReset();
	store.checkProjectVersion.mockResolvedValue({ success: true, data: { version: "1.5.0" } });
	store.initializeProject.mockResolvedValue({ success: true });
	store.updateProjectSettings.mockResolvedValue(true);
	store.checkGitHubConnection.mockResolvedValue({ connected: true, repoFullName: "o/r" });
	api = {
		getProjectEnv: vi.fn(async (id: string) => ({ success: true, data: env(id) })),
		updateProjectEnv: vi.fn().mockResolvedValue({ success: true }),
		checkClaudeAuth: vi.fn().mockResolvedValue({ success: true, data: { authenticated: true } }),
		invokeClaudeSetup: vi.fn().mockResolvedValue({ success: true, data: { authenticated: true } }),
		initializeGit: vi.fn().mockResolvedValue({ success: true }),
		checkLinearConnection: vi.fn().mockResolvedValue({ success: true, data: { connected: true, teamName: "core" } }),
		checkAzureDevOpsConnection: vi.fn().mockResolvedValue({ success: true, data: { connected: true } }),
		checkGitLabConnection: vi.fn().mockResolvedValue({ success: true, data: { connected: true } }),
	};
	(window as unknown as { electronAPI: unknown }).electronAPI = api;
});

async function opened(p = project()) {
	const hook = renderHook(({ proj, open }) => useProjectSettings(proj, open), { initialProps: { proj: p, open: true } });
	await waitFor(() => expect(hook.result.current.envConfig).not.toBeNull());
	await waitFor(() => expect(hook.result.current.claudeAuthStatus).not.toBe("checking"));
	return hook;
}

describe("opening the dialog", () => {
	it("reads the version, the environment and the Claude sign-in of the project", async () => {
		const { result } = await opened();
		expect(result.current).toMatchObject({
			settings: { model: "p1" },
			versionInfo: { version: "1.5.0" },
			envConfig: { project: "p1" },
			claudeAuthStatus: "authenticated",
			isLoadingEnv: false,
			isCheckingVersion: false,
			isCheckingClaudeAuth: false,
		});
		expect(store.setProjectEnvConfig).toHaveBeenCalledWith("p1", env("p1"));
	});

	it("reads nothing while closed or before the project is initialized", () => {
		const closed = project();
		renderHook(() => useProjectSettings(closed, false));
		const uninitialized = project("p2", { autoBuildPath: undefined });
		renderHook(() => useProjectSettings(uninitialized, true));
		expect(api.getProjectEnv).not.toHaveBeenCalled();
		expect(store.checkProjectVersion).not.toHaveBeenCalled();
		expect(api.checkClaudeAuth).not.toHaveBeenCalled();
	});

	it("says what it could not read", async () => {
		store.checkProjectVersion.mockResolvedValueOnce({ success: false });
		api.getProjectEnv.mockResolvedValueOnce({ success: false, error: "no .env" });
		api.checkClaudeAuth.mockResolvedValueOnce({ success: true, data: { authenticated: false } });
		const p = project();
		const { result } = renderHook(() => useProjectSettings(p, true));
		await waitFor(() => expect(result.current.envError).toBe("no .env"));
		await waitFor(() => expect(result.current.claudeAuthStatus).toBe("not_authenticated"));
		expect(result.current.versionInfo).toBeNull();
	});

	it.each([
		["the environment is refused without a reason", () => api.getProjectEnv.mockResolvedValueOnce({ success: false }), "Failed to load environment config"],
		["reading the environment throws", () => api.getProjectEnv.mockRejectedValueOnce(new Error("ipc closed")), "ipc closed"],
		["reading the environment throws a non-error", () => api.getProjectEnv.mockRejectedValueOnce("x"), "Unknown error"],
	])("shows why when %s", async (_name, fail, message) => {
		fail();
		const p = project();
		const { result } = renderHook(() => useProjectSettings(p, true));
		await waitFor(() => expect(result.current.envError).toBe(message));
	});

	it.each([
		["refused", () => api.checkClaudeAuth.mockResolvedValueOnce({ success: false })],
		["failing", () => api.checkClaudeAuth.mockRejectedValueOnce(new Error("x"))],
	])("shows the Claude sign-in as an error when its check is %s", async (_name, fail) => {
		fail();
		const p = project();
		const { result } = renderHook(() => useProjectSettings(p, true));
		await waitFor(() => expect(result.current.claudeAuthStatus).toBe("error"));
	});
});

describe("another project", () => {
	it("shows the new project's settings, and none of the last one's configuration while it loads", async () => {
		const hook = await opened();
		const slow = deferred();
		api.getProjectEnv.mockReturnValueOnce(slow.promise);
		hook.rerender({ proj: project("p2"), open: true });
		expect(hook.result.current.settings).toEqual({ model: "p2" });
		await waitFor(() => expect(hook.result.current.envConfig).toBeNull());
		await act(async () => slow.resolve({ success: true, data: env("p2") }));
		expect(hook.result.current.envConfig).toEqual(env("p2"));
	});

	it("keeps the configuration on screen when the same project's dialog opens again", async () => {
		const p = project();
		const hook = await opened(p);
		const slow = deferred();
		api.getProjectEnv.mockReturnValueOnce(slow.promise);
		hook.rerender({ proj: p, open: false });
		hook.rerender({ proj: p, open: true });
		expect(hook.result.current.envConfig).toEqual(env("p1"));
		await act(async () => slow.resolve({ success: true, data: env("p1", { githubRepo: "o/r" }) }));
		expect(hook.result.current.envConfig).toMatchObject({ githubRepo: "o/r" });
	});

	it("drops every answer that comes back for the project left behind", async () => {
		const envAnswer = deferred();
		const envFailure = deferred();
		const version = deferred();
		const auth = deferred();
		const authFailure = deferred();
		api.getProjectEnv.mockReturnValueOnce(envAnswer.promise);
		store.checkProjectVersion.mockReturnValueOnce(version.promise);
		api.checkClaudeAuth.mockReturnValueOnce(auth.promise);
		const hook = renderHook(({ proj }) => useProjectSettings(proj, true), { initialProps: { proj: project("p1") } });
		hook.rerender({ proj: project("p2") });
		await waitFor(() => expect(hook.result.current.envConfig).toEqual(env("p2")));
		await act(async () => {
			envAnswer.resolve({ success: true, data: env("p1") });
			version.resolve({ success: true, data: { version: "0.1" } });
			auth.resolve({ success: true, data: { authenticated: false } });
		});
		expect(hook.result.current).toMatchObject({ envConfig: env("p2"), versionInfo: { version: "1.5.0" }, claudeAuthStatus: "authenticated" });

		api.getProjectEnv.mockReturnValueOnce(envFailure.promise);
		api.checkClaudeAuth.mockReturnValueOnce(authFailure.promise);
		hook.rerender({ proj: project("p3") });
		hook.rerender({ proj: project("p4") });
		await waitFor(() => expect(hook.result.current.envConfig).toEqual(env("p4")));
		await act(async () => {
			envFailure.reject(new Error("late"));
			authFailure.reject(new Error("late"));
		});
		expect(hook.result.current).toMatchObject({ envError: null, claudeAuthStatus: "authenticated" });
	});

	it("never saves one project's configuration into another", async () => {
		const hook = await opened();
		const slow = deferred();
		api.getProjectEnv.mockReturnValueOnce(slow.promise);
		hook.rerender({ proj: project("p2"), open: true });
		act(() => hook.result.current.setEnvConfig(env("p1")));
		const onClose = vi.fn();
		await act(() => hook.result.current.handleSave(onClose));
		expect(store.updateProjectSettings).toHaveBeenCalledWith("p2", { model: "p2" });
		expect(api.updateProjectEnv).not.toHaveBeenCalled();
		expect(onClose).toHaveBeenCalled();

		await act(() => hook.result.current.updateEnvConfig({ githubRepo: "x" } as never));
		expect(api.updateProjectEnv).not.toHaveBeenCalled();
	});
});

describe("integration connections", () => {
	const integrations = {
		linear: { linearEnabled: true, linearApiKey: "lin-test-0000" },
		azure: { azureDevOpsEnabled: true, azureDevOpsPat: "ado-test-0000", azureDevOpsOrgUrl: "https://dev.azure.com/o" },
		github: { githubEnabled: true, githubToken: "ghp-test-0000", githubRepo: "o/r" },
		gitlab: { gitlabEnabled: true, gitlabToken: "glpat-test-0000", gitlabProject: "g/p" },
	};
	const all = { ...integrations.linear, ...integrations.azure, ...integrations.github, ...integrations.gitlab };

	it("checks each integration whose settings are complete", async () => {
		api.getProjectEnv.mockResolvedValue({ success: true, data: env("p1", all) });
		const { result } = await opened();
		await waitFor(() => expect(result.current.gitLabConnectionStatus).toEqual({ connected: true }));
		expect(result.current).toMatchObject({
			linearConnectionStatus: { connected: true, teamName: "core" },
			azureDevOpsConnectionStatus: { connected: true },
			gitHubConnectionStatus: { connected: true, repoFullName: "o/r" },
			isCheckingLinear: false,
			isCheckingGitHub: false,
		});
		expect(store.checkGitHubConnection).toHaveBeenCalledWith("p1");
		expect(api.checkLinearConnection).toHaveBeenCalledWith("p1");
	});

	it("checks none of the incomplete ones", async () => {
		api.getProjectEnv.mockResolvedValue({ success: true, data: env("p1", { linearEnabled: true, githubEnabled: true, githubToken: "ghp-test-0000" }) });
		const { result } = await opened();
		expect(api.checkLinearConnection).not.toHaveBeenCalled();
		expect(store.checkGitHubConnection).not.toHaveBeenCalled();
		expect(result.current.gitHubConnectionStatus).toBeNull();
	});

	it("forgets a connection once its integration is turned off, and checks again when its settings change", async () => {
		api.getProjectEnv.mockResolvedValue({ success: true, data: env("p1", integrations.github) });
		const { result } = await opened();
		await waitFor(() => expect(result.current.gitHubConnectionStatus?.connected).toBe(true));

		await act(() => result.current.updateEnvConfig({ githubRepo: "o/other" } as never));
		await waitFor(() => expect(store.checkGitHubConnection).toHaveBeenCalledTimes(2));

		await act(() => result.current.updateEnvConfig({ githubEnabled: false } as never));
		expect(result.current).toMatchObject({ gitHubConnectionStatus: null, isCheckingGitHub: false });
	});

	it("shows a check that throws as not connected, and keeps nothing a refused check returns", async () => {
		api.getProjectEnv.mockResolvedValue({ success: true, data: env("p1", all) });
		api.checkLinearConnection.mockRejectedValueOnce(new Error("x"));
		api.checkAzureDevOpsConnection.mockResolvedValueOnce({ success: false });
		store.checkGitHubConnection.mockResolvedValueOnce(null);
		api.checkGitLabConnection.mockResolvedValueOnce({ success: false });
		const { result } = await opened();
		await waitFor(() => expect(result.current.isCheckingLinear).toBe(false));
		await waitFor(() => expect(result.current.isCheckingGitLab).toBe(false));
		expect(result.current).toMatchObject({
			linearConnectionStatus: { connected: false, error: "Failed to check connection" },
			azureDevOpsConnectionStatus: null,
			gitHubConnectionStatus: null,
			gitLabConnectionStatus: null,
		});
	});

	it("keeps nothing a refused Linear check returns", async () => {
		api.getProjectEnv.mockResolvedValue({ success: true, data: env("p1", integrations.linear) });
		api.checkLinearConnection.mockResolvedValueOnce({ success: false });
		const { result } = await opened();
		await waitFor(() => expect(api.checkLinearConnection).toHaveBeenCalled());
		await waitFor(() => expect(result.current.isCheckingLinear).toBe(false));
		expect(result.current.linearConnectionStatus).toBeNull();
	});

	it("drops a check, or its failure, that comes back after the settings changed", async () => {
		const late = deferred();
		const failing = deferred();
		store.checkGitHubConnection.mockReturnValueOnce(late.promise).mockReturnValueOnce(failing.promise);
		api.getProjectEnv.mockResolvedValue({ success: true, data: env("p1", integrations.github) });
		const { result } = await opened();
		await act(() => result.current.updateEnvConfig({ githubRepo: "o/second" } as never));
		await act(() => result.current.updateEnvConfig({ githubRepo: "o/third" } as never));
		await waitFor(() => expect(result.current.gitHubConnectionStatus?.connected).toBe(true));
		await act(async () => {
			late.resolve({ connected: false, error: "late" });
			failing.reject(new Error("late"));
		});
		expect(result.current.gitHubConnectionStatus).toEqual({ connected: true, repoFullName: "o/r" });
	});
});

describe("editing the environment", () => {
	it("shows and shares each change at once, then saves it", async () => {
		const { result } = await opened();
		await act(() => result.current.updateEnvConfig({ githubRepo: "o/r" } as never));
		await act(() => result.current.updateEnvConfig({ githubToken: "ghp-test-0000" } as never));
		expect(result.current.envConfig).toMatchObject({ githubRepo: "o/r", githubToken: "ghp-test-0000" });
		expect(api.updateProjectEnv).toHaveBeenLastCalledWith("p1", expect.objectContaining({ githubRepo: "o/r", githubToken: "ghp-test-0000" }));
		expect(store.setProjectEnvConfig).toHaveBeenLastCalledWith("p1", expect.objectContaining({ githubRepo: "o/r" }));
		expect(result.current.envError).toBeNull();
	});

	it("keeps the change on screen and says why it was not saved", async () => {
		const errors = vi.spyOn(console, "error").mockReturnValue(undefined);
		const { result } = await opened();
		api.updateProjectEnv.mockResolvedValueOnce({ success: false, error: "read-only" });
		await act(() => result.current.updateEnvConfig({ githubRepo: "a" } as never));
		expect(result.current).toMatchObject({ envError: "read-only", envConfig: { githubRepo: "a" } });
		api.updateProjectEnv.mockResolvedValueOnce({ success: false });
		await act(() => result.current.updateEnvConfig({ githubRepo: "b" } as never));
		expect(result.current.envError).toBe("Failed to save environment config");
		api.updateProjectEnv.mockRejectedValueOnce(new Error("disk full"));
		await act(() => result.current.updateEnvConfig({ githubRepo: "c" } as never));
		expect(result.current.envError).toBe("disk full");
		api.updateProjectEnv.mockRejectedValueOnce("x");
		await act(() => result.current.updateEnvConfig({ githubRepo: "d" } as never));
		expect(result.current.envError).toBe("Failed to save environment config");
		expect(errors).toHaveBeenCalledTimes(4);
	});

	it("saves nothing before a configuration was read", async () => {
		const warn = vi.spyOn(console, "warn").mockReturnValue(undefined);
		api.getProjectEnv.mockResolvedValueOnce({ success: false });
		const p = project();
		const { result } = renderHook(() => useProjectSettings(p, true));
		await waitFor(() => expect(result.current.isLoadingEnv).toBe(false));
		await act(() => result.current.updateEnvConfig({ githubRepo: "x" } as never));
		expect(api.updateProjectEnv).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalled();
	});
});

describe("initializing the project", () => {
	it("initializes, then reads the project, its version and its environment again", async () => {
		const uninitialized = project("p1", { autoBuildPath: undefined });
		const { result } = renderHook(() => useProjectSettings(uninitialized, true));
		expect(result.current.envConfig).toBeNull();
		await act(() => result.current.handleInitialize());
		expect(store.initializeProject).toHaveBeenCalledWith("p1");
		expect(store.refreshProjects).toHaveBeenCalled();
		expect(result.current).toMatchObject({ versionInfo: { version: "1.5.0" }, envConfig: { project: "p1" }, isUpdating: false });
	});

	it("keeps what it had when the re-reads after initializing find nothing", async () => {
		const { result } = await opened();
		store.checkProjectVersion.mockResolvedValueOnce({ success: false });
		api.getProjectEnv.mockResolvedValueOnce({ success: false });
		await act(() => result.current.handleInitialize());
		expect(result.current).toMatchObject({ versionInfo: null, envConfig: { project: "p1" } });
	});

	it("shows a blocker it can walk the person out of, and any other failure as an error", async () => {
		const { result } = await opened();
		store.initializeProject.mockResolvedValueOnce({ success: false, data: { blocker: "git-missing" } });
		await act(() => result.current.handleInitialize());
		expect(result.current).toMatchObject({ initBlocker: "git-missing", error: null });
		store.initializeProject.mockResolvedValueOnce({ success: false, error: "disk full" });
		await act(() => result.current.handleInitialize());
		expect(result.current).toMatchObject({ initBlocker: null, error: "disk full" });
		store.initializeProject.mockResolvedValueOnce(undefined);
		await act(() => result.current.handleInitialize());
		expect(result.current.error).toBe("Failed to initialize");
		store.initializeProject.mockRejectedValueOnce(new Error("crash"));
		await act(() => result.current.handleInitialize());
		expect(result.current.error).toBe("crash");
		store.initializeProject.mockRejectedValueOnce(0);
		await act(() => result.current.handleInitialize());
		expect(result.current).toMatchObject({ error: "Unknown error", isUpdating: false });
	});

	it("repairs git with the person's identity, then initializes", async () => {
		const { result } = await opened();
		await act(() => result.current.handleRepairGit({ name: "Ada", email: "ada@example.test" }));
		expect(api.initializeGit).toHaveBeenCalledWith("/repos/p1", undefined, { name: "Ada", email: "ada@example.test" });
		expect(store.initializeProject).toHaveBeenCalled();
		expect(result.current).toMatchObject({ initBlocker: null, isRepairingGit: false });
	});

	it("asks for an identity, or says why git could not be prepared", async () => {
		const { result } = await opened();
		api.initializeGit.mockResolvedValueOnce({ success: false, data: { blocker: "git-identity-missing" } });
		await act(() => result.current.handleRepairGit());
		expect(result.current.initBlocker).toBe("git-identity-missing");
		api.initializeGit.mockResolvedValueOnce({ success: false, error: "not a directory" });
		await act(() => result.current.handleRepairGit());
		expect(result.current.error).toBe("not a directory");
		api.initializeGit.mockResolvedValueOnce(undefined);
		await act(() => result.current.handleRepairGit());
		expect(result.current.error).toBe("Failed to prepare the git repository");
		api.initializeGit.mockRejectedValueOnce(new Error("crash"));
		await act(() => result.current.handleRepairGit());
		expect(result.current.error).toBe("crash");
		api.initializeGit.mockRejectedValueOnce(0);
		await act(() => result.current.handleRepairGit());
		expect(result.current).toMatchObject({ error: "Unknown error", isRepairingGit: false });
		expect(store.initializeProject).not.toHaveBeenCalled();
	});
});

describe("Claude sign-in", () => {
	it("signs in and reads the environment the setup wrote", async () => {
		const { result } = await opened();
		api.getProjectEnv.mockResolvedValueOnce({ success: true, data: env("p1", { claudeOAuthToken: "set" }) });
		await act(() => result.current.handleClaudeSetup());
		expect(result.current).toMatchObject({ claudeAuthStatus: "authenticated", envConfig: { claudeOAuthToken: "set" }, isCheckingClaudeAuth: false });
	});

	it("keeps the status when the setup did not sign in, and shows a failed setup", async () => {
		const { result } = await opened();
		act(() => result.current.setClaudeAuthStatus("not_authenticated"));
		api.invokeClaudeSetup.mockResolvedValueOnce({ success: true, data: { authenticated: false } });
		await act(() => result.current.handleClaudeSetup());
		expect(result.current.claudeAuthStatus).toBe("not_authenticated");
		api.invokeClaudeSetup.mockResolvedValueOnce({ success: true, data: { authenticated: true } });
		api.getProjectEnv.mockResolvedValueOnce({ success: false });
		await act(() => result.current.handleClaudeSetup());
		expect(result.current).toMatchObject({ claudeAuthStatus: "authenticated", envConfig: { project: "p1" } });
		api.invokeClaudeSetup.mockRejectedValueOnce(new Error("x"));
		await act(() => result.current.handleClaudeSetup());
		expect(result.current).toMatchObject({ claudeAuthStatus: "error", isCheckingClaudeAuth: false });
	});
});

describe("saving", () => {
	it("saves the settings and the environment, then closes", async () => {
		const { result } = await opened();
		act(() => result.current.setSettings({ model: "opus" } as never));
		const onClose = vi.fn();
		await act(() => result.current.handleSave(onClose));
		expect(store.updateProjectSettings).toHaveBeenCalledWith("p1", { model: "opus" });
		expect(api.updateProjectEnv).toHaveBeenCalledWith("p1", env("p1"));
		expect(onClose).toHaveBeenCalled();
		expect(result.current.isSaving).toBe(false);
	});

	it("stays open and says why when something was not saved", async () => {
		const { result } = await opened();
		const onClose = vi.fn();
		store.updateProjectSettings.mockResolvedValueOnce(false);
		await act(() => result.current.handleSave(onClose));
		expect(result.current.error).toBe("Failed to save settings");
		api.updateProjectEnv.mockResolvedValueOnce({ success: false, error: "read-only" });
		await act(() => result.current.handleSave(onClose));
		expect(result.current.error).toBe("read-only");
		api.updateProjectEnv.mockResolvedValueOnce({ success: false });
		await act(() => result.current.handleSave(onClose));
		expect(result.current.error).toBe("Failed to save environment config");
		store.updateProjectSettings.mockRejectedValueOnce(new Error("crash"));
		await act(() => result.current.handleSave(onClose));
		expect(result.current.error).toBe("crash");
		store.updateProjectSettings.mockRejectedValueOnce(0);
		await act(() => result.current.handleSave(onClose));
		expect(result.current).toMatchObject({ error: "Unknown error", isSaving: false });
		expect(onClose).not.toHaveBeenCalled();
		act(() => result.current.setError(null));
		expect(result.current.error).toBeNull();
	});
});

describe("the dialog's own toggles", () => {
	it("opens sections and shows or hides each secret", async () => {
		const { result } = await opened();
		expect(result.current.expandedSections).toEqual({ claude: true, linear: false, github: false });
		act(() => result.current.toggleSection("linear"));
		act(() => result.current.toggleSection("claude"));
		expect(result.current.expandedSections).toMatchObject({ claude: false, linear: true });
		act(() => {
			result.current.setShowClaudeToken(true);
			result.current.setShowLinearKey(true);
			result.current.setShowGitHubToken(true);
			result.current.setShowGitLabToken(true);
			result.current.setShowAzureDevOpsToken(true);
			result.current.setShowLinearImportModal(true);
			result.current.setShowAzureDevOpsImportModal(true);
			result.current.setEnvError("e");
		});
		expect(result.current).toMatchObject({
			showClaudeToken: true,
			showLinearKey: true,
			showGitHubToken: true,
			showGitLabToken: true,
			showAzureDevOpsToken: true,
			showLinearImportModal: true,
			showAzureDevOpsImportModal: true,
			envError: "e",
		});
	});
});
